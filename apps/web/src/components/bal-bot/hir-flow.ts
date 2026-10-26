import type { Id, HIRProgram, HIRGraph, HIRGraphReference, HIRPresence, HIRBinding, HIREmissionPlan, HIRInterface, HIREdgeStyle, HIRRecursivePresentation } from '@bal-bot/workspace';
import type { Diagram, DiagramNode, DiagramPort, DiagramEdge, ExpansionPath } from './hir-diagram';
export type { Diagram, DiagramNode, DiagramPort, DiagramEdge, ExpansionPath } from './hir-diagram';
type EffectiveInterfaces = ReadonlyMap<Id, readonly Id[]>;
interface Instance extends Diagram {
  nodes: DiagramNode[]; ports: DiagramPort[]; edges: DiagramEdge[];
  interfaces: Map<Id, readonly Id[]>; bindings: Map<Id, DiagramEdge[]>;
  exports: Map<Id, readonly Id[]>;
  localNodes: Map<Id, DiagramNode>; localPorts: Map<Id, DiagramPort>; localEdges: Map<Id, DiagramEdge>;
  parents: Map<Id, Id>; flatNodes: DiagramNode[];
  referenceInterfaces: Map<Id, EffectiveInterfaces>;
  columnLeftMembers: Map<Id, ReadonlySet<Id>>;
}
function emptyDiagram(): Instance {
  return { nodes: [], ports: [], edges: [], interfaces: new Map(), bindings: new Map(), exports: new Map(), localNodes: new Map(), localPorts: new Map(), localEdges: new Map(), parents: new Map(), flatNodes: [], referenceInterfaces: new Map(), columnLeftMembers: new Map() };
}
function required<T>(value: T | undefined, id: string): T { if (value === undefined) throw new Error(`Invalid compiler HIR: missing ${id}`); return value; }
function evaluatePresence(expression: HIRPresence, references: ReadonlyMap<Id, EffectiveInterfaces>): boolean {
  switch (expression.kind) {
    case 'constant': return expression.value;
    case 'all': return expression.operands.every(p => evaluatePresence(p, references));
    case 'any': return expression.operands.some(p => evaluatePresence(p, references));
    case 'not': return !evaluatePresence(expression.operand, references);
    case 'nonempty': return required(required(references.get(expression.referenceNodeId), expression.referenceNodeId).get(expression.interfaceId), expression.interfaceId).length > 0;
  }
}
function edge(fromPort: Id, toPort: Id, style: HIREdgeStyle): DiagramEdge {
  return { fromPort, toPort, kind: style.kind, routing: style.routing, ...(style.label === null ? {} : { label: style.label }) };
}
// Lazy interface lookup is essential: collapsed siblings may query one another,
// including a later declared reference. Protocol validation rejects cycles.
class LazyInterfaces extends Map<Id, readonly Id[]> {
  private active = new Set<Id>();
  private definitions: readonly HIRInterface[];
  private resolve: (value: HIRInterface) => readonly Id[];
  constructor(definitions: readonly HIRInterface[], resolve: (value: HIRInterface) => readonly Id[]) { super(); this.definitions = definitions; this.resolve = resolve; }
  override get(id: Id): readonly Id[] | undefined {
    if (super.has(id)) return super.get(id);
    const definition = this.definitions.find(i => i.id === id);
    if (!definition) return undefined;
    if (this.active.has(id)) throw new Error('Invalid compiler HIR: cyclic interface dependency');
    this.active.add(id);
    try { const value = this.resolve(definition); this.set(id, value); return value; }
    finally { this.active.delete(id); }
  }
}
function bindInterfaces(caller: Diagram, child: Diagram, bindings: readonly HIRBinding[]): void {
  const local = caller as Instance;
  for (const binding of bindings) {
    if (!evaluatePresence(binding.when, local.referenceInterfaces)) { local.bindings.set(binding.id, []); local.exports.set(binding.id, []); continue; }
    const ports = required(child.interfaces.get(binding.targetInterfaceId), binding.targetInterfaceId);
    if (binding.kind === 'export') { local.exports.set(binding.id, ports); local.bindings.set(binding.id, []); }
    else {
      const port = required(local.localPorts.get(binding.callerPortId), binding.callerPortId).id;
      local.bindings.set(binding.id, ports.map(p => binding.kind === 'entry' ? edge(port, p, binding.edge) : edge(p, port, binding.edge)));
    }
  }
}
function emitInstances(plan: HIREmissionPlan, diagram: Diagram, references: ReadonlyMap<Id, Diagram>): Diagram {
  const local = diagram as Instance;
  for (const stream of ['nodes', 'ports', 'edges'] as const) {
    const output: unknown[] = [];
    for (const slot of plan[stream]) {
      if (!evaluatePresence(slot.when, local.referenceInterfaces)) continue;
      if (slot.kind === 'local') {
        const item = stream === 'nodes' ? local.localNodes.get(slot.itemId) : stream === 'ports' ? local.localPorts.get(slot.itemId) : local.localEdges.get(slot.itemId);
        if (item !== undefined) output.push(item);
      } else if (slot.kind === 'child') {
        const child = required(references.get(slot.referenceNodeId), slot.referenceNodeId) as Instance;
        output.push(...(stream === 'nodes' ? child.flatNodes : child[stream]));
      } else output.push(...required(local.bindings.get(slot.bindingId), slot.bindingId));
    }
    if (stream === 'nodes') local.flatNodes = output as DiagramNode[];
    else if (stream === 'ports') local.ports = output as DiagramPort[];
    else local.edges = output as DiagramEdge[];
  }
  // Resolve ownership, not emission adjacency. Invisible inline containers are
  // transparent; their descendants retain the nearest visible owning ancestor.
  const visible = new Map(local.flatNodes.filter(n => n.layout.visibility.node).map(n => [n.id, n]));
  const children = new Map<Id, DiagramNode[]>(), roots: DiagramNode[] = [];
  const copies = new Map<Id, DiagramNode>();
  for (const node of visible.values()) copies.set(node.id, { ...node, children: [] });
  for (const node of visible.values()) {
    let parent = local.parents.get(node.id);
    while (parent && !visible.has(parent)) parent = local.parents.get(parent);
    const copy = required(copies.get(node.id), node.id);
    if (!parent) roots.push(copy);
    else { const list = children.get(parent) ?? []; list.push(copy); children.set(parent, list); }
  }
  for (const [id, node] of copies) {
    const owned = children.get(id) ?? [];
    (node as { children: readonly DiagramNode[] }).children = owned;
    const left = local.columnLeftMembers.get(id);
    if (left) {
      // A transparent member can promote zero, one, or many children. Trace
      // each effective child back to the declared member of this column group.
      const split = owned.filter(child => {
        let member = child.id;
        while (local.parents.has(member) && local.parents.get(member) !== id) member = required(local.parents.get(member), member);
        return left.has(member);
      }).length;
      (node as { layout: DiagramNode['layout'] }).layout = { ...node.layout, split };
    }
  }
  local.nodes = roots;
  // flatNodes deliberately retains transparent nodes for enclosing ownership.
  return local;
}
export function instantiateGraph(program: HIRProgram, functionId: Id, expanded: ReadonlySet<ExpansionPath>): Diagram {
  const graph = Object.hasOwn(program.functions, functionId) ? program.functions[functionId] : undefined;
  const instance = graph ? instantiate(program, graph, functionId, [functionId], expanded, false) : emptyDiagram();
  return { nodes: instance.nodes, ports: instance.ports, edges: instance.edges, interfaces: instance.interfaces, bindings: instance.bindings, ...(instance.geometry ? { geometry: instance.geometry } : {}) };
}
function instantiateReference(program: HIRProgram, reference: HIRGraphReference, occurrence: ExpansionPath, ancestors: readonly Id[], expanded: ReadonlySet<ExpansionPath>): Diagram {
  const target = required(program.functions[reference.graphId], reference.graphId);
  if (reference.availability.kind !== 'available' || ancestors.includes(reference.graphId) || !expanded.has(occurrence)) return emptyDiagram();
  return instantiate(program, target, occurrence, [...ancestors, reference.graphId], expanded, true);
}
function instantiate(program: HIRProgram, graph: HIRGraph, occurrence: string, ancestors: readonly Id[], expanded: ReadonlySet<ExpansionPath>, inline: boolean): Instance {
  const contexts = expanded;
  const local = emptyDiagram(), references = new Map<Id, Diagram>();
  const groups = new Map(graph.groups.map(g => [g.id, g]));
  const qualified = new Map(graph.nodes.map(n => [n.id, occurrence + n.occurrenceKey]));
  const port = (id: Id) => required(local.localPorts.get(id), id).id;
  for (const node of graph.nodes) {
    const group = node.body.kind === 'group' ? required(groups.get(node.body.groupId), node.body.groupId) : undefined;
    const ref = node.body.kind === 'reference' ? node.body.reference : undefined;
    const recursive = ref ? ancestors.includes(ref.graphId) : false;
    const path = ref ? occurrence + ref.occurrenceKey : undefined;
    const isExpanded = !!ref && !recursive && ref.availability.kind === 'available' && expanded.has(path!);
    const style = group?.style ?? ref?.container;
    const declaredVisibility = style ? (inline ? style.inline : style.root) : { node: true, header: true, container: true };
    const visibility = ref && !isExpanded ? { ...declaredVisibility, node: true } : declaredVisibility;
    let presentation = node.presentation;
    let contextPath: string | undefined;
    let recursivePresentation: HIRRecursivePresentation | undefined;
    if (presentation.kind !== 'hidden') {
      const disclosure = presentation.disclosure;
      if (disclosure.kind === 'client-context') {
        contextPath = occurrence + disclosure.occurrenceKey;
        const content = contexts.has(contextPath) ? disclosure.expanded : disclosure.collapsed;
        presentation = { ...presentation, ...content };
      }
      const call = disclosure.kind === 'call' ? disclosure : disclosure.kind === 'client-context' ? disclosure.call : null;
      if (recursive && call) {
        recursivePresentation = disclosure.kind === 'client-context' && contexts.has(contextPath!) ? disclosure.expandedRecursive! : call.recursive;
        presentation = { ...presentation, ...recursivePresentation };
      }
    }
    local.localNodes.set(node.id, {
      ...(node.calls ? { calls: node.calls } : {}),
      id: required(qualified.get(node.id), node.id), kind: presentation.kind === 'hidden' ? 'step' : presentation.style,
      label: presentation.kind === 'hidden' ? '' : presentation.label, selection: required(program.sources[node.sourceId], node.sourceId), children: [], presentation,
      layout: { profile: style?.profile ?? 'sequence', root: group?.style.profile === 'root', visibility: presentation.kind === 'hidden' ? { node: false, header: false, container: false } : visibility,
        ...(group?.arrangement.kind === 'columns' ? { split: group.arrangement.left.length } : {}),
        ...(ref ? { reference: { path: path!, expanded: isExpanded, recursive, ...(ref.availability.kind === 'unavailable' ? { unavailable: ref.availability.reason } : {}), ...(recursivePresentation ? { recursivePresentation } : {}) } } : {}) },
      ...(contextPath ? { contextPath, contextExpanded: contexts.has(contextPath) } : {}),
    });
    if (group) {
      if (group.arrangement.kind === 'columns') local.columnLeftMembers.set(required(qualified.get(node.id), node.id), new Set(group.arrangement.left.map(member => required(qualified.get(member), member))));
      const members = group.arrangement.kind === 'columns' ? [...group.arrangement.left, ...group.arrangement.right] : group.arrangement.members;
      for (const member of members) local.parents.set(required(qualified.get(member), member), required(qualified.get(node.id), node.id));
    }
  }
  for (const p of graph.ports) local.localPorts.set(p.id, { id: occurrence + p.occurrenceKey, nodeId: required(qualified.get(p.nodeId), p.nodeId), role: p.role, anchor: p.anchor });
  const resolveMembers = (iface: HIRInterface): Id[] => iface.members.filter(m => evaluatePresence(m.when, local.referenceInterfaces)).map(m => port(m.portId));
  // Instantiate in declared order, but defer all collapsed dependency queries
  // until every reference has an interface resolver installed.
  for (const node of graph.nodes) if (node.body.kind === 'reference') {
    const ref = node.body.reference, path = occurrence + ref.occurrenceKey;
    const child = instantiateReference(program, ref, path, ancestors, expanded) as Instance;
    references.set(node.id, child);
    const active = ref.availability.kind === 'available' && !ancestors.includes(ref.graphId) && expanded.has(path);
    local.referenceInterfaces.set(node.id, active ? child.interfaces : new LazyInterfaces(ref.collapsed.interfaces, resolveMembers));
    if (active) {
      for (const [id, parent] of child.parents) local.parents.set(id, parent);
      for (const [id, left] of child.columnLeftMembers) local.columnLeftMembers.set(id, left);
      for (const childNode of child.geometry?.nodes ?? child.flatNodes) {
        let root = childNode.id;
        while (child.parents.has(root)) root = required(child.parents.get(root), root);
        local.parents.set(root, required(qualified.get(node.id), node.id));
      }
    }
  }
  // Resolve all fallback interfaces first: malformed cycles cannot be hidden by
  // a short-circuited emission predicate.
  for (const node of graph.nodes) if (node.body.kind === 'reference') {
    const ref = node.body.reference;
    const effective = required(local.referenceInterfaces.get(node.id), node.id);
    for (const iface of ref.collapsed.interfaces) required(effective.get(iface.id), iface.id);
    const active = ref.availability.kind === 'available' && !ancestors.includes(ref.graphId) && expanded.has(occurrence + ref.occurrenceKey);
    if (active) bindInterfaces(local, { ...required(references.get(node.id), node.id), interfaces: effective }, ref.inline);
    else for (const binding of ref.inline) { local.bindings.set(binding.id, []); local.exports.set(binding.id, []); }
  }
  for (const iface of graph.interfaces) {
    const members: Id[] = [];
    for (let i = 0; i <= iface.members.length; i++) {
      for (const exp of iface.exports) if (exp.beforeMember === i) members.push(...required(local.exports.get(exp.bindingId), exp.bindingId));
      const member = iface.members[i];
      if (member && evaluatePresence(member.when, local.referenceInterfaces)) members.push(port(member.portId));
    }
    local.interfaces.set(iface.id, members);
    const root = iface.root;
    if (root.kind === 'connect') local.bindings.set(root.bindingId, inline ? [] : members.map(p => edge(p, port(root.toPort), root.edge)));
  }
  for (const e of graph.edges) if (evaluatePresence(e.when, local.referenceInterfaces)) local.localEdges.set(e.id, edge(port(e.fromPort), port(e.toPort), e));
  for (const node of graph.nodes) if (node.body.kind === 'reference') {
    const ref = node.body.reference;
    const active = ref.availability.kind === 'available' && !ancestors.includes(ref.graphId) && expanded.has(occurrence + ref.occurrenceKey);
    if (!active) for (const e of ref.collapsed.edges) if (evaluatePresence(e.when, local.referenceInterfaces)) local.localEdges.set(e.id, edge(port(e.fromPort), port(e.toPort), e));
  }
  const result = emitInstances(inline ? graph.emission.inline : graph.emission.root, local, references) as Instance;
  // Keep declared owners, including transparent leaves, available to layout.
  // Structural order comes from groups, not from the omission of invisible
  // owners in the node emission stream. This never reorders that stream.
  const geometryNodes = new Map<Id, DiagramNode>();
  const geometryParents = new Map(local.parents);
  const geometryGroups = new Map<Id, { members: readonly Id[]; left?: ReadonlySet<Id> }>();
  const recordGroup = (owner: Id, groupId: Id): void => {
    const group = required(groups.get(groupId), groupId), arrangement = group.arrangement;
    const members = arrangement.kind === 'columns' ? [...arrangement.left, ...arrangement.right] : arrangement.members;
    geometryGroups.set(owner, { members: members.map(id => required(qualified.get(id), id)),
      ...(arrangement.kind === 'columns' ? { left: new Set(arrangement.left.map(id => required(qualified.get(id), id))) } : {}) });
  };
  const visitGroup = (groupId: Id): void => {
    const group = required(groups.get(groupId), groupId);
    const members = group.arrangement.kind === 'columns' ? [...group.arrangement.left, ...group.arrangement.right] : group.arrangement.members;
    for (const id of members) {
      const node = required(local.localNodes.get(id), id);
      geometryNodes.set(node.id, node);
      const declaration = required(graph.nodes.find(node => node.id === id), id);
      if (declaration.body.kind === 'group') {
        recordGroup(node.id, declaration.body.groupId);
        visitGroup(declaration.body.groupId);
      }
      if (declaration.body.kind === 'reference') {
        const childGeometry = references.get(id)?.geometry;
        for (const child of childGeometry?.nodes ?? []) {
          geometryNodes.set(child.id, child);
          geometryParents.set(child.id, childGeometry!.parents.get(child.id) ?? node.id);
        }
        for (const [owner, group] of childGeometry?.groups ?? []) geometryGroups.set(owner, group);
      }
    }
  };
  visitGroup(graph.rootGroup);
  const rootGroup = required(groups.get(graph.rootGroup), graph.rootGroup);
  if (rootGroup.arrangement.kind === 'columns') {
    // This key identifies an existing HIR group only within render geometry;
    // it is not a source, occurrence, emitted node or selectable primitive.
    const key = JSON.stringify([occurrence, graph.rootGroup]);
    recordGroup(key, graph.rootGroup);
    geometryNodes.set(key, { id: key, kind: 'step', label: '', selection: graph, children: [], presentation: { kind: 'hidden' },
      layout: { profile: rootGroup.style.profile, root: true, split: rootGroup.arrangement.left.length, visibility: { node: false, header: false, container: false } } });
    for (const member of geometryGroups.get(key)!.members) geometryParents.set(member, key);
  }
  (result as { geometry: Diagram['geometry'] }).geometry = { nodes: [...geometryNodes.values()], parents: geometryParents, groups: geometryGroups };
  return result;
}

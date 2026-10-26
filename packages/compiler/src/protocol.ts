import type { Files, CompilationResult, Diagnostic, Position, AnalysisResult, Located } from '@bal-bot/workspace';
import { sourceText } from '@bal-bot/workspace';
import type { HIRProgram, HIRGraph, HIRNode, HIRGroup, HIRGraphReference, HIRPresence, HIRInterface, HIRBinding, HIREmissionPlan } from '@bal-bot/workspace';

export type CompilerRequest = { readonly operation: 'check' | 'analyze'; readonly files: Files };
export type CompilerResponse =
  | { readonly kind: 'result'; readonly operation: 'check'; readonly result: CompilationResult }
  | { readonly kind: 'result'; readonly operation: 'analyze'; readonly result: AnalysisResult }
  | { readonly kind: 'failure'; readonly message: string };
export interface CompilerBridge { request(json: string): string; }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const position = (v: unknown): v is Position => record(v) && Number.isSafeInteger(v.line) && Number(v.line) > 0 && Number.isSafeInteger(v.column) && Number(v.column) > 0;
const range = (v: unknown) => record(v) && position(v.start) && position(v.end) && (v.end.line > v.start.line || v.end.line === v.start.line && v.end.column >= v.start.column);
const diagnostic = (v: unknown): v is Diagnostic => record(v) && ['internal', 'hint', 'info', 'warning', 'error', 'fatal'].includes(String(v.severity)) && typeof v.message === 'string' && (v.code === undefined || typeof v.code === 'string') && (v.file === undefined || typeof v.file === 'string') && (v.range === undefined || typeof v.file === 'string' && !!v.file && range(v.range));
function fail(): never { throw new Error('Invalid compiler response.'); }
function object(v: unknown): Record<string, unknown> { if (!record(v)) fail(); return v; }
function array(v: unknown): unknown[] { if (!Array.isArray(v)) fail(); return v; }
function string(v: unknown): string { if (typeof v !== 'string' || !v) fail(); return v; }
function located(value: unknown): Record<string, unknown> {
  const v = object(value), source = object(v.source); string(v.id); string(source.file);
  if (!range(source.range) || typeof v.text !== 'string') fail();
  return v;
}
function unique(values: unknown[]): void { const ids = values.map(v => string(object(v).id)); if (new Set(ids).size !== ids.length) fail(); }
// Discovery retains its optional-field behavior and resolves functions directly
// against the HIR graph table; no statement-tree compatibility model is built.
function validateDiscovery(value: unknown, functions: Record<string, unknown>): void {
  const scopes = array(value);
  const functionId = (id: unknown) => { if (!Object.hasOwn(functions, string(id))) fail(); };
  unique(scopes);
  const endpoints = new Set<string>();
  for (const value of scopes) {
    const scope = located(value); string(scope.title); string(scope.moduleId);
    if (scope.kind === 'automation') { if (scope.title !== 'Automation') fail(); functionId(scope.functionId); }
    else if (scope.kind === 'service') {
      if (scope.serviceType !== null && typeof scope.serviceType !== 'string' || scope.functionId !== undefined) fail();
      const eps = array(scope.endpoints); unique(eps);
      for (const value of eps) { const ep = located(value); if (endpoints.has(string(ep.id))) fail(); endpoints.add(string(ep.id)); if (!['resource', 'remote'].includes(String(ep.kind))) fail(); string(ep.title); functionId(ep.functionId); }
      const defs = array(scope.definitions); unique(defs);
      for (const value of defs) { const def = located(value); string(def.label); if (def.kind === 'function') functionId(def.functionId); else if (!['type', 'connector', 'configurable'].includes(String(def.kind)) || def.functionId !== undefined) fail(); }
    } else fail();
  }
}
// Visit flat source records and discovery metadata once; never follow graph references.
export function programLocations(program: HIRProgram): Located[] {
  const result: Located[] = [...Object.values(program.sources), ...Object.values(program.functions), ...Object.values(program.functionViews ?? {})];
  for (const scope of program.scopes) {
    result.push(scope);
    if (scope.kind === 'service') result.push(...scope.endpoints, ...scope.definitions);
  }
  return result;
}
export function validateAnalysisFiles(result: AnalysisResult, files: Files): void {
  if (result.kind !== 'valid') return;
  for (const node of programLocations(result.program)) if (sourceText(files, node.source) !== node.text) throw new Error('Compiler source text does not match its captured range.');
}
export function validateResponse(value: unknown): CompilerResponse {
  const v = object(value);
  if (v.kind === 'failure' && typeof v.message === 'string') return { kind: 'failure', message: v.message };
  if (v.kind !== 'result' || !['check', 'analyze'].includes(String(v.operation))) fail();
  const r = object(v.result); if (!array(r.diagnostics).every(diagnostic)) fail();
  if (v.operation === 'analyze') {
    if (r.kind === 'valid') { validateHIR(r.program); if ((r.diagnostics as Diagnostic[]).some(d => ['error', 'fatal', 'internal'].includes(d.severity))) fail(); }
    else if (r.kind !== 'invalid' || r.program !== undefined) fail();
  }
  return value as CompilerResponse;
}
export function validateRequest(value: unknown): CompilerRequest {
  if (!record(value) || !['check', 'analyze'].includes(String(value.operation)) || !record(value.files) || !Object.values(value.files).every(v => typeof v === 'string')) throw new Error('Invalid compiler request.');
  return value as CompilerRequest;
}

// Analyze responses use HIR. Discovery metadata retains its existing shape.
// Every failure is a bridge/infrastructure error; never normalize wire data.
function hirFail(message: string): never { throw new Error(`Invalid compiler HIR: ${message}`); }
function hirAssert(condition: unknown, message = 'invalid shape'): asserts condition { if (!condition) hirFail(message); }
function hirObject(value: unknown, keys?: string, optional = ''): Record<string, unknown> {
  hirAssert(record(value));
  Object.keys(value).forEach(hirString);
  if (keys !== undefined) {
    const expected = keys.split(' ');
    const allowed = [...expected, ...optional.split(' ').filter(Boolean)];
    hirAssert(expected.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => allowed.includes(k)), 'unexpected or missing field');
  }
  return value;
}
// Only approved presentation fields may contain isolated UTF-16 code units.
function hirPresentationText(value: unknown): void { hirAssert(typeof value === 'string'); }
function hirString(value: unknown): void {
  hirPresentationText(value);
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      hirAssert(low >= 0xdc00 && low <= 0xdfff, 'invalid Unicode scalar string');
    } else hirAssert(unit < 0xdc00 || unit > 0xdfff, 'invalid Unicode scalar string');
  }
}
function hirId(value: unknown): void { hirString(value); hirAssert((value as string).length > 0, 'empty identity'); }
function hirNullable(value: unknown): void { if (value !== null) hirString(value); }
function hirEnum(value: unknown, choices: string): void { hirAssert(typeof value === 'string' && choices.split(' ').includes(value), 'invalid enum'); }
function hirList(value: unknown, visit: (value: unknown) => void): void { hirAssert(Array.isArray(value), 'expected collection'); value.forEach(visit); }
function hirLocated(value: unknown): void {
  const v = hirObject(value); hirId(v.id); hirString(v.text);
  const s = hirObject(v.source, 'file range'); hirId(s.file);
  const r = hirObject(s.range, 'start end');
  for (const p of [r.start, r.end]) { const q = hirObject(p, 'line column'); hirAssert(position(q)); }
  hirAssert(range(r), 'invalid source range');
}
// Go omits empty occurrence arrays. Omission and [] are valid, but null
// (or an explicitly present undefined) is not a collection on the wire.
function hirVariables(v: Record<string, unknown>, text: unknown, key = 'variables'): void {
  if (!Object.hasOwn(v, key)) return;
  hirPresentationText(text);
  let end = 0;
  hirList(v[key], item => {
    const occurrence = hirObject(item, 'variableId start end'); hirId(occurrence.variableId);
    hirAssert(Number.isSafeInteger(occurrence.start) && Number.isSafeInteger(occurrence.end) &&
      Number(occurrence.start) >= end && Number(occurrence.end) > Number(occurrence.start) &&
      Number(occurrence.end) <= (text as string).length, 'invalid variable span');
    end = Number(occurrence.end);
  });
}
function hirSections(value: unknown): void {
  hirList(value, item => { const v = hirObject(item, 'kind text', 'variables'); hirEnum(v.kind, 'text receiver context method error-message error-cause error-detail template-type template-expression'); hirPresentationText(v.text); hirVariables(v, v.text); });
}
function hirLabel(value: unknown): void { const v = hirObject(value, 'label sections', 'variables'); hirPresentationText(v.label); hirVariables(v, v.label); hirSections(v.sections); }
function hirAvailability(value: unknown): void {
  const v = hirObject(value);
  if (v.kind === 'available') hirObject(v, 'kind');
  else { hirObject(v, 'kind reason'); hirAssert(v.kind === 'unavailable'); hirString(v.reason); }
}
function hirVisibility(value: unknown): void { const v = hirObject(value, 'node header container'); Object.values(v).forEach(x => hirAssert(typeof x === 'boolean')); }
function hirGroupStyle(value: unknown): void {
  const v = hirObject(value, 'profile root inline'); hirEnum(v.profile, 'sequence if while foreach trap root call'); hirVisibility(v.root); hirVisibility(v.inline);
}
function hirEdgeStyle(value: unknown): void {
  const v = hirObject(value); hirEnum(v.kind, 'sequence true false back break continue return error panic'); hirNullable(v.label); hirEnum(v.routing, 'direct branch-left branch-right back');
}
function hirPresence(value: unknown): void {
  const v = hirObject(value);
  switch (v.kind) {
    case 'constant': hirObject(v, 'kind value'); hirAssert(typeof v.value === 'boolean'); break;
    case 'all': case 'any': hirObject(v, 'kind operands'); hirList(v.operands, hirPresence); break;
    case 'not': hirObject(v, 'kind operand'); hirPresence(v.operand); break;
    case 'nonempty': hirObject(v, 'kind referenceNodeId interfaceId'); hirId(v.referenceNodeId); hirId(v.interfaceId); break;
    default: hirFail('unknown presence');
  }
}
function hirEdge(value: unknown): void {
  const v = hirObject(value, 'id fromPort toPort kind label routing when'); hirId(v.id); hirId(v.fromPort); hirId(v.toPort); hirEdgeStyle(v); hirPresence(v.when);
}
function hirInterface(value: unknown): void {
  const v = hirObject(value, 'id members exports root'); hirId(v.id);
  hirList(v.members, item => { const m = hirObject(item, 'portId when'); hirId(m.portId); hirPresence(m.when); });
  hirList(v.exports, item => { const e = hirObject(item, 'bindingId beforeMember'); hirId(e.bindingId); hirAssert(Number.isSafeInteger(e.beforeMember) && Number(e.beforeMember) >= 0); });
  const r = hirObject(v.root);
  if (r.kind === 'terminal') hirObject(r, 'kind');
  else { hirObject(r, 'kind bindingId toPort edge'); hirAssert(r.kind === 'connect'); hirId(r.bindingId); hirId(r.toPort); hirObject(r.edge, 'kind label routing'); hirEdgeStyle(r.edge); }
}
function hirBinding(value: unknown): void {
  const v = hirObject(value);
  if (v.kind === 'export') { hirObject(v, 'kind id when targetInterfaceId callerInterfaceId'); hirId(v.callerInterfaceId); }
  else { hirObject(v, 'kind id when callerPortId targetInterfaceId edge'); hirEnum(v.kind, 'entry exit'); hirId(v.callerPortId); hirObject(v.edge, 'kind label routing'); hirEdgeStyle(v.edge); }
  hirId(v.id); hirId(v.targetInterfaceId); hirPresence(v.when);
}
function validateReference(value: unknown): HIRGraphReference {
  const v = hirObject(value, 'graphId occurrenceKey availability container collapsed inline');
  hirId(v.graphId); hirId(v.occurrenceKey); hirAvailability(v.availability); hirGroupStyle(v.container);
  const c = hirObject(v.collapsed, 'interfaces edges'); hirList(c.interfaces, hirInterface); hirList(c.edges, hirEdge); hirList(v.inline, hirBinding);
  return value as HIRGraphReference;
}
function hirCallDisclosure(value: unknown): void {
  const d = hirObject(value, 'kind occurrenceKey availability recursive'); hirAssert(d.kind === 'call'); hirId(d.occurrenceKey); hirAvailability(d.availability);
  hirRecursivePresentation(d.recursive);
}
function hirRecursivePresentation(value: unknown): void {
  const r = hirObject(value, 'label sections limitation title ariaLabel glyph', 'variables');
  hirPresentationText(r.label); hirVariables(r, r.label); hirSections(r.sections); hirNullable(r.limitation); hirPresentationText(r.title); hirPresentationText(r.ariaLabel); hirString(r.glyph);
}
function validateNode(value: unknown): HIRNode {
  const fields = record(value) && Object.hasOwn(value, 'calls') ? 'id occurrenceKey sourceId presentation body calls' : 'id occurrenceKey sourceId presentation body';
  const v = hirObject(value, fields); hirId(v.id); hirId(v.occurrenceKey); hirId(v.sourceId);
  const p = hirObject(v.presentation);
  if (p.kind === 'hidden') hirObject(p, 'kind');
  else {
    hirObject(p, 'kind style label sections limitation disclosure', 'variables'); hirEnum(p.kind, 'plain client');
    hirEnum(p.style, 'step condition function loop mapping unsupported return client trap panic template error-constructor');
    if (p.kind === 'client') hirAssert(p.style === 'client');
    hirPresentationText(p.label); hirVariables(p, p.label); hirSections(p.sections); hirNullable(p.limitation);
    const sections = p.sections as {kind: string; text: string}[];
    if (sections.some(s => s.kind === 'template-type' || s.kind === 'template-expression')) {
      hirAssert(p.kind === 'plain' && p.style === 'template' && sections.length === 2 &&
        sections[0].kind === 'template-type' && ['string', 'xml'].includes(sections[0].text) &&
        sections[1].kind === 'template-expression', 'invalid template sections');
    }
    const d = hirObject(p.disclosure);
    switch (d.kind) {
      case 'none': hirObject(d, 'kind'); break;
      case 'call': hirCallDisclosure(d); break;
      case 'client-context':
        hirObject(d, 'kind occurrenceKey collapsed expanded call expandedRecursive'); hirId(d.occurrenceKey); hirLabel(d.collapsed); hirLabel(d.expanded);
        hirAssert((d.call === null) === (d.expandedRecursive === null));
        if (d.expandedRecursive !== null) hirRecursivePresentation(d.expandedRecursive);
        if (d.call !== null) hirCallDisclosure(d.call); break;
      default: hirFail('unknown disclosure');
    }
  }
  if (Object.hasOwn(v, 'calls')) {
    let previousEnd = 0;
    hirList(v.calls, item => {
      const c = hirObject(item, 'start end targetId unavailable');
      hirAssert(Number.isInteger(c.start) && Number.isInteger(c.end) && (c.start as number) >= previousEnd && (c.end as number) > (c.start as number), 'invalid call span');
      hirAssert(p.kind !== 'hidden' && typeof p.label === 'string' && (c.end as number) <= p.label.length, 'call outside label');
      hirNullable(c.targetId); hirNullable(c.unavailable);
      hirAssert((c.targetId === null) !== (c.unavailable === null), 'call needs a target or unavailability reason');
      if (c.targetId !== null) hirId(c.targetId);
      if (c.unavailable !== null) hirId(c.unavailable);
      previousEnd = c.end as number;
    });
  }
  const b = hirObject(v.body);
  switch (b.kind) {
    case 'leaf': hirObject(b, 'kind'); break;
    case 'group': hirObject(b, 'kind groupId'); hirId(b.groupId); break;
    case 'reference': hirObject(b, 'kind reference'); validateReference(b.reference); break;
    default: hirFail('unknown node body');
  }
  return value as HIRNode;
}
function validateGroup(value: unknown): HIRGroup {
  const v = hirObject(value, 'id arrangement style'); hirId(v.id); hirGroupStyle(v.style);
  const a = hirObject(v.arrangement);
  if (a.kind === 'columns') { hirObject(a, 'kind left right'); hirList(a.left, hirId); hirList(a.right, hirId); }
  else { hirObject(a, 'kind members'); hirEnum(a.kind, 'sequence container'); hirList(a.members, hirId); }
  return value as HIRGroup;
}
function hirPlan(value: unknown): void {
  const v = hirObject(value, 'nodes ports edges');
  for (const stream of Object.values(v)) hirList(stream, item => {
    const e = hirObject(item);
    if (e.kind === 'local') { hirObject(e, 'kind itemId when'); hirId(e.itemId); }
    else if (e.kind === 'child') { hirObject(e, 'kind referenceNodeId when'); hirId(e.referenceNodeId); }
    else { hirObject(e, 'kind bindingId when'); hirAssert(e.kind === 'binding'); hirId(e.bindingId); }
    hirPresence(e.when);
  });
}
function validateGraph(value: unknown): HIRGraph {
  const g = hirObject(value, 'id source text moduleId entry nodes ports edges groups rootGroup interfaces emission'); hirLocated(g); hirId(g.moduleId); hirId(g.rootGroup);
  const e = hirObject(g.entry, 'kind owner operation name signature parameters returnType', 'signatureVariables');
  hirEnum(e.kind, 'resource remote function method'); hirNullable(e.owner); hirNullable(e.operation); hirId(e.name); hirId(e.signature); hirId(e.returnType);
  hirVariables(e, e.signature, 'signatureVariables');
  hirList(e.parameters, item => { const p = hirObject(item, 'label text', 'variables'); hirEnum(p.label, 'Path Input'); hirId(p.text); hirVariables(p, p.text); });
  hirList(g.nodes, validateNode); hirList(g.groups, validateGroup); hirList(g.edges, hirEdge); hirList(g.interfaces, hirInterface);
  hirList(g.ports, item => {
    const p = hirObject(item, 'id occurrenceKey nodeId role anchor'); hirId(p.occurrenceKey); hirId(p.id); hirId(p.nodeId); hirEnum(p.role, 'entry normal-exit true false return break continue next-iteration panic');
    const a = hirObject(p.anchor, 'kind'); hirEnum(a.kind, 'top-center header-left header-right header-bottom-center bottom-center group-bottom-center iteration-marker');
  });
  const emission = hirObject(g.emission, 'root inline'); hirPlan(emission.root); hirPlan(emission.inline);
  return value as HIRGraph;
}
function hirIndex<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) { hirAssert(!result.has(item.id), `duplicate identity ${item.id}`); result.set(item.id, item); }
  return result;
}
function hirGet<T>(index: ReadonlyMap<string, T>, id: string): T { hirAssert(index.has(id), `dangling identity ${id}`); return index.get(id)!; }
function hirMembers(g: HIRGroup): readonly string[] { return g.arrangement.kind === 'columns' ? [...g.arrangement.left, ...g.arrangement.right] : g.arrangement.members; }

export function validateHIR(value: unknown): HIRProgram {
  const fields = record(value) && Object.hasOwn(value, 'functionViews') ? 'scopes sources functions functionViews' : 'scopes sources functions';
  const p = hirObject(value, fields), sources = hirObject(p.sources), functions = hirObject(p.functions);
  if (Object.hasOwn(p, 'functionViews')) {
    const views = hirObject(p.functionViews);
    for (const [id, graph] of Object.entries(views)) {
      hirAssert(Object.hasOwn(functions, id) && validateGraph(graph).id === id, 'function view key mismatch');
    }
  }
  for (const [id, source] of Object.entries(sources)) { hirObject(source, 'id source text'); hirLocated(source); hirAssert(object(source).id === id, 'source key mismatch'); }
  for (const [id, graph] of Object.entries(functions)) { hirAssert(validateGraph(graph).id === id, 'graph key mismatch'); }
  // Discovery is also used by the legacy protocol; enforce the HIR scalar
  // contract here without changing legacy validation or metadata encoding.
  const discoveryUnicode = (item: unknown): void => {
    if (typeof item === 'string') hirString(item);
    else if (Array.isArray(item)) item.forEach(discoveryUnicode);
    else if (record(item)) { hirObject(item); Object.values(item).forEach(discoveryUnicode); }
  };
  discoveryUnicode(p.scopes);
  validateDiscovery(p.scopes, functions);
  const program = value as HIRProgram;
  for (const item of programLocations(program)) {
    hirAssert(Object.hasOwn(sources, item.id), 'missing source identity');
    const s = sources[item.id] as unknown as Located, a = item.source.range, b = s.source.range;
    hirAssert(item.text === s.text && item.source.file === s.source.file && a.start.line === b.start.line && a.start.column === b.start.column && a.end.line === b.end.line && a.end.column === b.end.column, 'source identity disagreement');
  }
  validateLinks(program);
  if (program.functionViews) validateLinks({ ...program, functions: program.functionViews, functionViews: undefined });
  return program;
}

// Reduced ordered binary decision diagrams make conditional coverage exact without
// enumerating (or imposing a size cap on) disclosure configurations.
class HIRBoolean {
  private readonly nodes: { variable: number; low: number; high: number }[] = [
    { variable: Infinity, low: 0, high: 0 }, { variable: Infinity, low: 1, high: 1 },
  ];
  private readonly unique = new Map<string, number>();
  private readonly cache = new Map<string, number>();
  private variables = 0;
  variable(): number { return this.make(this.variables++, 0, 1); }
  private make(variable: number, low: number, high: number): number {
    if (low === high) return low;
    const key = `${variable},${low},${high}`, found = this.unique.get(key);
    if (found !== undefined) return found;
    const id = this.nodes.length; this.nodes.push({ variable, low, high }); this.unique.set(key, id); return id;
  }
  not(value: number): number { return this.apply('xor', value, 1); }
  and(a: number, b: number): number { return this.apply('and', a, b); }
  or(a: number, b: number): number { return this.apply('or', a, b); }
  private apply(op: 'and' | 'or' | 'xor', a: number, b: number): number {
    if (a > b) [a, b] = [b, a];
    if (op === 'and') { if (a === 0 || a === b) return a; if (a === 1) return b; }
    if (op === 'or') { if (a === 0 || a === b) return b; if (a === 1) return 1; }
    if (op === 'xor') { if (a === 0) return b; if (a === b) return 0; }
    const key = `${op},${a},${b}`, found = this.cache.get(key); if (found !== undefined) return found;
    const x = this.nodes[a]!, y = this.nodes[b]!, variable = Math.min(x.variable, y.variable);
    const low = this.apply(op, x.variable === variable ? x.low : a, y.variable === variable ? y.low : b);
    const high = this.apply(op, x.variable === variable ? x.high : a, y.variable === variable ? y.high : b);
    const result = this.make(variable, low, high); this.cache.set(key, result); return result;
  }
  implies(a: number, b: number): boolean { return this.and(a, this.not(b)) === 0; }
}
interface HIRGraphIndex {
  graph: HIRGraph;
  nodes: Map<string, HIRNode>;
  ports: Map<string, HIRGraph['ports'][number]>;
  groups: Map<string, HIRGroup>;
  interfaces: Map<string, HIRInterface>;
  edges: Map<string, HIRGraph['edges'][number]>;
  references: Map<string, HIRGraphReference>;
  bindings: Map<string, { reference: string | null; binding: HIRBinding | null; iface: HIRInterface | null }>;
  collapsedEdges: Map<string, string>;
  preorder: string[];
}
function validateLinks(program: HIRProgram): void {
  const indexes = new Map<string, HIRGraphIndex>();
  for (const graph of Object.values(program.functions)) {
    const nodes = hirIndex(graph.nodes), ports = hirIndex(graph.ports), groups = hirIndex(graph.groups), interfaces = hirIndex(graph.interfaces);
    const references = new Map<string, HIRGraphReference>(), bindings: HIRGraphIndex['bindings'] = new Map(), collapsedEdges = new Map<string, string>();
    const edges = hirIndex(graph.edges), preorder: string[] = [];
    const occurrenceKeys = new Set<string>(), disclosureKeys = new Set<string>();
    const addBinding = (id: string, value: HIRGraphIndex['bindings'] extends Map<string, infer T> ? T : never) => { hirAssert(!bindings.has(id), 'duplicate binding'); bindings.set(id, value); };
    for (const node of nodes.values()) {
      hirAssert(Object.hasOwn(program.sources, node.sourceId), 'unknown sourceId');
      for (const call of node.calls ?? []) if (call.targetId !== null) hirAssert(Object.hasOwn(program.functions, call.targetId), 'unknown call target');
      hirAssert(!occurrenceKeys.has(node.occurrenceKey), 'duplicate node occurrenceKey'); occurrenceKeys.add(node.occurrenceKey);
      const disclosure = node.presentation.kind === 'hidden' ? null : node.presentation.disclosure;
      const call = disclosure?.kind === 'call' ? disclosure : disclosure?.kind === 'client-context' ? disclosure.call : null;
      const keys = disclosure?.kind === 'client-context' ? [disclosure.occurrenceKey] : [];
      if (call) keys.push(call.occurrenceKey);
      for (const key of keys) { hirAssert(!disclosureKeys.has(key), 'duplicate disclosure occurrenceKey'); disclosureKeys.add(key); }
      if (call) hirAssert(node.body.kind === 'reference', 'call disclosure without reference');
      if (node.presentation.kind === 'client' && node.body.kind === 'reference') hirAssert(call !== null, 'client reference missing call disclosure');
      if (node.body.kind === 'reference') {
        const ref = node.body.reference; references.set(node.id, ref);
        hirAssert(Object.hasOwn(program.functions, ref.graphId), 'unknown referenced graph');
        for (const other of references.values()) if (other !== ref) hirAssert(other.occurrenceKey !== ref.occurrenceKey, 'duplicate reference occurrenceKey');
        if (call) {
          hirAssert(call.occurrenceKey === ref.occurrenceKey, 'call occurrence disagreement');
          const availability = call.availability;
          hirAssert(availability.kind === ref.availability.kind &&
            (availability.kind !== 'unavailable' ||
              (ref.availability.kind === 'unavailable' && availability.reason === ref.availability.reason)), 'call availability disagreement');
        }
        for (const edge of ref.collapsed.edges) { hirAssert(!edges.has(edge.id), 'duplicate collapsed edge'); edges.set(edge.id, edge); collapsedEdges.set(edge.id, node.id); }
        hirIndex(ref.collapsed.interfaces);
        for (const iface of ref.collapsed.interfaces) {
          hirAssert(iface.exports.length === 0, 'collapsed interface exports bindings');
          // Collapsed root treatments are not executed: root connections belong
          // to the instantiated graph's root plan, never a reference fallback.
          hirAssert(iface.root.kind === 'terminal', 'collapsed interface has root connection');
        }
        for (const binding of ref.inline) addBinding(binding.id, { reference: node.id, binding, iface: null });
      }
    }
    for (const iface of interfaces.values()) if (iface.root.kind === 'connect') addBinding(iface.root.bindingId, { reference: null, binding: null, iface });
    for (const port of ports.values()) {
      hirGet(nodes, port.nodeId);
      hirAssert(!occurrenceKeys.has(port.occurrenceKey), 'duplicate port occurrenceKey'); occurrenceKeys.add(port.occurrenceKey);
    }
    for (const edge of edges.values()) { hirGet(ports, edge.fromPort); hirGet(ports, edge.toPort); }
    const groupOwner = new Map<string, string>();
    for (const node of nodes.values()) if (node.body.kind === 'group') {
      hirGet(groups, node.body.groupId); hirAssert(!groupOwner.has(node.body.groupId), 'multiply-owned group'); groupOwner.set(node.body.groupId, node.id);
    }
    hirGet(groups, graph.rootGroup); hirAssert(!groupOwner.has(graph.rootGroup), 'root group owned by a node');
    hirAssert(groups.size === groupOwner.size + 1, 'unowned group');
    const owned = new Set<string>(), visitedGroups = new Set<string>();
    const walk = (id: string) => {
      hirAssert(!visitedGroups.has(id), 'group ownership cycle'); visitedGroups.add(id);
      for (const nodeId of hirMembers(hirGet(groups, id))) {
        const node = hirGet(nodes, nodeId); hirAssert(!owned.has(nodeId), 'multiply-owned node'); owned.add(nodeId); preorder.push(nodeId);
        if (node.body.kind === 'group') walk(node.body.groupId);
      }
    };
    walk(graph.rootGroup); hirAssert(owned.size === nodes.size && visitedGroups.size === groups.size, 'unreachable ownership or cycle');
    indexes.set(graph.id, { graph, nodes, ports, groups, interfaces, edges, references, bindings, collapsedEdges, preorder });
  }
  // Validate namespaces independently of whether a condition is satisfiable.
  for (const index of indexes.values()) {
    const { graph, references, ports, interfaces, bindings } = index;
    const checkPresence = (p: HIRPresence) => {
      if (p.kind === 'nonempty') {
        const ref = hirGet(references, p.referenceNodeId), target = hirGet(indexes, ref.graphId);
        hirGet(target.interfaces, p.interfaceId);
        hirAssert(ref.collapsed.interfaces.some(i => i.id === p.interfaceId), 'missing collapsed interface');
      } else if (p.kind === 'not') checkPresence(p.operand);
      else if (p.kind === 'all' || p.kind === 'any') p.operands.forEach(checkPresence);
    };
    const checkInterface = (iface: HIRInterface, collapsed: boolean) => {
      for (const member of iface.members) { hirGet(ports, member.portId); checkPresence(member.when); }
      if (iface.root.kind === 'connect') hirGet(ports, iface.root.toPort);
      const seen = new Set<string>();
      for (const exp of iface.exports) {
        hirAssert(!collapsed && exp.beforeMember <= iface.members.length, 'invalid export insertion');
        const b = hirGet(bindings, exp.bindingId).binding;
        hirAssert(b?.kind === 'export' && b.callerInterfaceId === iface.id && !seen.has(b.id), 'invalid interface export'); seen.add(b.id);
      }
    };
    for (const iface of interfaces.values()) checkInterface(iface, false);
    for (const [nodeId, ref] of references) {
      const target = hirGet(indexes, ref.graphId);
      for (const iface of ref.collapsed.interfaces) { hirGet(target.interfaces, iface.id); checkInterface(iface, true); }
      for (const b of ref.inline) {
        checkPresence(b.when); hirGet(target.interfaces, b.targetInterfaceId);
        if (b.kind === 'export') {
          const iface = hirGet(interfaces, b.callerInterfaceId);
          hirAssert(iface.exports.filter(e => e.bindingId === b.id).length === 1, 'unlisted export binding');
        } else hirGet(ports, b.callerPortId);
      }
      // A call disclosure belongs to a reference, not an unrelated leaf.
      hirAssert(index.nodes.get(nodeId)?.body.kind === 'reference');
    }
    for (const node of index.nodes.values()) if (node.presentation.kind !== 'hidden' && node.presentation.disclosure.kind === 'call') hirAssert(references.has(node.id), 'call disclosure without reference');
    for (const edge of index.edges.values()) checkPresence(edge.when);
    for (const plan of [graph.emission.root, graph.emission.inline]) for (const stream of ['nodes', 'ports', 'edges'] as const) for (const e of plan[stream]) {
      checkPresence(e.when);
      if (e.kind === 'local') hirGet(stream === 'nodes' ? index.nodes : stream === 'ports' ? index.ports : index.edges as Map<string, unknown>, e.itemId);
      else if (e.kind === 'child') hirGet(references, e.referenceNodeId);
      else { hirAssert(stream === 'edges', 'binding emission outside edge stream'); const b = hirGet(bindings, e.bindingId); hirAssert(b.binding?.kind !== 'export', 'export binding emits edges'); }
    }
  }
  validateHIRInstantiations(indexes);
}

interface HIRInstance {
  index: HIRGraphIndex;
  mode: 'root' | 'inline';
  expanded: Map<string, number>;
  children: Map<string, HIRInstance>;
  interfaces: Map<string, number>;
  referenceInterfaces: Map<string, number>;
  visiting: Set<string>;
  presence: Map<HIRPresence, number>;
  emittedPorts?: Map<string, number>;
}
function validateHIRInstantiations(indexes: Map<string, HIRGraphIndex>): void {
  for (const root of indexes.values()) for (const rootMode of ['root', 'inline'] as const) {
    const boolean = new HIRBoolean();
    const build = (index: HIRGraphIndex, mode: 'root' | 'inline', ancestors: ReadonlySet<string>): HIRInstance => {
      const instance: HIRInstance = { index, mode, expanded: new Map(), children: new Map(), interfaces: new Map(), referenceInterfaces: new Map(), visiting: new Set(), presence: new Map() };
      const ancestry = new Set(ancestors); ancestry.add(index.graph.id);
      for (const [id, ref] of index.references) {
        const expands = ref.availability.kind === 'available' && !ancestry.has(ref.graphId);
        instance.expanded.set(id, expands ? boolean.variable() : 0);
        if (expands) instance.children.set(id, build(hirGet(indexes, ref.graphId), 'inline', ancestry));
      }
      return instance;
    };
    const instance = build(root, rootMode, new Set());
    const guarded = (i: HIRInstance, key: string, calculate: () => number): number => {
      hirAssert(!i.visiting.has(key), 'interface/presence dependency cycle'); i.visiting.add(key);
      const value = calculate(); i.visiting.delete(key); return value;
    };
    const presence = (i: HIRInstance, p: HIRPresence): number => {
      const found = i.presence.get(p); if (found !== undefined) return found;
      let value: number;
      switch (p.kind) {
        case 'constant': value = p.value ? 1 : 0; break;
        case 'not': value = boolean.not(presence(i, p.operand)); break;
        case 'all': value = p.operands.reduce((v, p) => boolean.and(v, presence(i, p)), 1); break;
        case 'any': value = p.operands.reduce((v, p) => boolean.or(v, presence(i, p)), 0); break;
        case 'nonempty': value = referenceInterface(i, p.referenceNodeId, p.interfaceId); break;
      }
      i.presence.set(p, value); return value;
    };
    const members = (i: HIRInstance, iface: HIRInterface): number => iface.members.reduce((v, m) => boolean.or(v, presence(i, m.when)), 0);
    const referenceInterface = (i: HIRInstance, nodeId: string, ifaceId: string): number => {
      const key = JSON.stringify([nodeId, ifaceId]), found = i.referenceInterfaces.get(key); if (found !== undefined) return found;
      const value = guarded(i, `reference:${key}`, () => {
        const ref = hirGet(i.index.references, nodeId), expanded = hirGet(i.expanded, nodeId);
        const collapsed = ref.collapsed.interfaces.find(iface => iface.id === ifaceId)!;
        const fallback = members(i, collapsed);
        const child = i.children.get(nodeId);
        return boolean.or(boolean.and(boolean.not(expanded), fallback), child ? boolean.and(expanded, effectiveInterface(child, ifaceId)) : 0);
      });
      i.referenceInterfaces.set(key, value); return value;
    };
    const bindingResult = (i: HIRInstance, reference: string, b: HIRBinding): number => {
      const child = i.children.get(reference);
      // Recursion-stopped and unavailable references have no inline bindings.
      // Validate their presence structurally, but do not follow target exports.
      if (!child) return 0;
      const condition = presence(i, b.when);
      return boolean.and(hirGet(i.expanded, reference), boolean.and(condition, effectiveInterface(child, b.targetInterfaceId)));
    };
    const effectiveInterface = (i: HIRInstance, id: string): number => {
      const found = i.interfaces.get(id); if (found !== undefined) return found;
      const value = guarded(i, `interface:${id}`, () => {
        const iface = hirGet(i.index.interfaces, id);
        let value = members(i, iface);
        for (const exp of iface.exports) {
          const record = hirGet(i.index.bindings, exp.bindingId);
          value = boolean.or(value, bindingResult(i, record.reference!, record.binding!));
        }
        return value;
      });
      i.interfaces.set(id, value); return value;
    };
    // Follow concrete members and nested exports only when an edge batch
    // consumes them; unused mode-hidden structural interfaces remain legal.
    const requireInterface = (i: HIRInstance, id: string, demand: number): void => {
      const iface = hirGet(i.index.interfaces, id);
      for (const member of iface.members) {
        // A structural member need not have a slot (e.g. a suppressed root).
        // Absence is false emission, not a dangling port identity; the graph's
        // port registry was checked already. Only active consumers demand it.
        hirAssert(boolean.implies(boolean.and(demand, presence(i, member.when)), i.emittedPorts!.get(member.portId) ?? 0), 'active binding targets unemitted interface port');
      }
      for (const exp of iface.exports) {
        const record = hirGet(i.index.bindings, exp.bindingId), binding = record.binding!;
        const child = i.children.get(record.reference!);
        if (child) requireInterface(child, binding.targetInterfaceId, boolean.and(demand, bindingResult(i, record.reference!, binding)));
      }
    };
    const validate = (i: HIRInstance): number => {
      const childNodes = new Map<string, number>();
      for (const [id, child] of i.children) childNodes.set(id, validate(child));
      const { index, mode } = i, plan = index.graph.emission[mode];
      for (const iface of index.interfaces.values()) effectiveInterface(i, iface.id);
      for (const [nodeId, ref] of index.references) {
        for (const iface of ref.collapsed.interfaces) referenceInterface(i, nodeId, iface.id);
        if (i.children.has(nodeId)) for (const b of ref.inline) presence(i, b.when);
      }
      const nodeActive = new Map<string, number>();
      for (const node of index.nodes.values()) {
        let active = node.presentation.kind === 'hidden' ? 0 : 1;
        if (node.body.kind === 'group') active = hirGet(index.groups, node.body.groupId).style[mode].node ? active : 0;
        if (node.body.kind === 'reference') {
          const expanded = hirGet(i.expanded, node.id);
          active = boolean.and(active, node.body.reference.container[mode].node ? 1 : boolean.not(expanded));
        }
        nodeActive.set(node.id, active);
      }
      const portActive = new Map<string, number>();
      // Port slot guards describe creation; consumers independently demand endpoints.
      for (const port of index.ports.values()) portActive.set(port.id, 0);
      const edgeActive = new Map<string, number>();
      for (const edge of index.edges.values()) {
        const ref = index.collapsedEdges.get(edge.id);
        const active = boolean.and(presence(i, edge.when), ref === undefined ? 1 : boolean.not(hirGet(i.expanded, ref)));
        edgeActive.set(edge.id, active);
        portActive.set(edge.fromPort, boolean.or(hirGet(portActive, edge.fromPort), active));
        portActive.set(edge.toPort, boolean.or(hirGet(portActive, edge.toPort), active));
      }
      const bindingActive = new Map<string, number>();
      for (const [id, record] of index.bindings) {
        let active = 0;
        if (record.binding && record.reference !== null) {
          active = bindingResult(i, record.reference, record.binding);
          if (record.binding.kind !== 'export') portActive.set(record.binding.callerPortId, boolean.or(hirGet(portActive, record.binding.callerPortId), active));
          else active = 0; // Interface exports never produce an edge batch.
        } else if (mode === 'root') {
          active = effectiveInterface(i, record.iface!.id);
          const treatment = record.iface!.root;
          if (treatment.kind === 'connect') portActive.set(treatment.toPort, boolean.or(hirGet(portActive, treatment.toPort), active));
        }
        bindingActive.set(id, active);
      }
      const portDemand = new Map(portActive);
      // Mode-hidden roots remain suppressed unless consumed. Interface queries
      // alone do not force creation of their members.
      for (const port of index.ports.values()) portActive.set(port.id, boolean.or(hirGet(nodeActive, port.nodeId), hirGet(portDemand, port.id)));
      const checkStream = (stream: keyof HIREmissionPlan, expected: Map<string, number>) => {
        const slots = new Map<string, number>(), childSlots = new Map<string, number>(), bindingSlots = new Map<string, number>();
        const ordered: { rank: number; active: number }[] = [];
        for (const emission of plan[stream]) {
          const when = presence(i, emission.when);
          let key: string, intrinsic: number, seen: Map<string, number>;
          if (emission.kind === 'local') {
            key = emission.itemId; intrinsic = hirGet(expected, key); seen = slots;
            const collapsedOwner = stream === 'edges' ? index.collapsedEdges.get(key) : undefined;
            const modeMask = collapsedOwner === undefined ? 1 : boolean.not(hirGet(i.expanded, collapsedOwner));
            hirAssert(boolean.implies(boolean.and(when, modeMask), intrinsic), 'inactive local item emitted');
            if (stream === 'nodes') ordered.push({ rank: index.preorder.indexOf(key) * 2, active: boolean.and(intrinsic, when) });
          } else if (emission.kind === 'child') {
            key = emission.referenceNodeId; intrinsic = hirGet(i.expanded, key); seen = childSlots;
            // A child subtree follows its reference header, before the next
            // local node. Empty slices impose no rendered-node ordering.
            if (stream === 'nodes') ordered.push({ rank: index.preorder.indexOf(key) * 2 + 1, active: boolean.and(boolean.and(intrinsic, when), childNodes.get(key) ?? 0) });
          } else { key = emission.bindingId; intrinsic = hirGet(bindingActive, key); seen = bindingSlots; }
          const active = boolean.and(intrinsic, when), prior = seen.get(key) ?? 0;
          hirAssert(boolean.and(prior, active) === 0, 'duplicate active emission'); seen.set(key, boolean.or(prior, active));
        }
        for (const [key, active] of expected) {
          const emitted = slots.get(key) ?? 0;
          if (stream === 'ports') {
            // Require a satisfiable local slot, not unconditional creation.
            hirAssert(active === 0 || emitted !== 0, `missing port emission ${key}`);
            hirAssert(boolean.implies(hirGet(portDemand, key), emitted), `active endpoint targets unemitted port ${key}`);
          } else hirAssert(emitted === active, `missing active ${stream} emission ${key}`);
        }
        if (stream === 'ports') i.emittedPorts = slots;
        for (const [key, active] of i.expanded) hirAssert((childSlots.get(key) ?? 0) === active, `missing child ${stream} slice`);
        if (stream === 'edges') for (const [key, active] of bindingActive) hirAssert((bindingSlots.get(key) ?? 0) === active, 'missing binding edge emission');
        for (let a = 0; a < ordered.length; a++) for (let b = a + 1; b < ordered.length; b++) {
          if (ordered[a]!.rank > ordered[b]!.rank) hirAssert(boolean.and(ordered[a]!.active, ordered[b]!.active) === 0, 'node emission violates ownership preorder');
        }
      };
      checkStream('nodes', nodeActive); checkStream('ports', portActive); checkStream('edges', edgeActive);
      // Check consumers against actual slot predicates, not owner visibility:
      // a consumer must not invent ports in its child's stream.
      for (const [id, record] of index.bindings) {
        const demand = hirGet(bindingActive, id);
        if (record.binding) {
          const child = i.children.get(record.reference!);
          if (child && record.binding.kind !== 'export') requireInterface(child, record.binding.targetInterfaceId, demand);
        } else requireInterface(i, record.iface!.id, demand);
      }
      let nonempty = 0;
      for (const active of nodeActive.values()) nonempty = boolean.or(nonempty, active);
      for (const [id, active] of childNodes) nonempty = boolean.or(nonempty, boolean.and(hirGet(i.expanded, id), active));
      return nonempty;
    };
    validate(instance);
  }
}

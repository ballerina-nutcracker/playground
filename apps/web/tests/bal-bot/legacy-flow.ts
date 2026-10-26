// Frozen numeric/builder oracle for comparisons only. Never used to construct HIR.
import type { Id, Located, ScopeModel } from '@bal-bot/workspace';
type CallTarget = { readonly kind: 'workspace'; readonly functionId: Id } | { readonly kind: 'external'; readonly label: string };
interface ReceiverContext { readonly receiver: Located; readonly type?: string; readonly origin: 'constructor' | 'initializer' | 'parameter' | 'unavailable'; readonly initializer?: Located; }
interface ClientInvocation { readonly context: ReceiverContext; readonly method: string; readonly arguments: readonly Located[]; }
interface Evaluation extends Located { readonly kind: 'source' | 'call' | 'check' | 'checkpanic' | 'trap' | 'template'; readonly children: readonly Evaluation[]; readonly call?: CallSite; readonly strings?: readonly string[]; }
type CallSite = Located & { readonly client?: ClientInvocation } & ({ readonly target: { readonly kind: 'workspace'; readonly functionId: Id }; readonly expansion: 'supported' } | { readonly target: CallTarget; readonly expansion: 'unavailable'; readonly reason: string });
interface Expression extends Located { readonly calls: readonly CallSite[]; readonly evaluation?: Evaluation; }
type Statement = Located & { readonly evaluation?: Evaluation; readonly binding?: string } & (
  | { readonly kind: 'simple'; readonly operation: 'declare' | 'assign' | 'expression'; readonly presentation: 'step' | 'mapping'; readonly calls: readonly CallSite[] }
  | { readonly kind: 'return'; readonly calls: readonly CallSite[] }
  | { readonly kind: 'if'; readonly condition: Expression; readonly thenBody: readonly Statement[]; readonly elseBody: readonly Statement[] }
  | { readonly kind: 'while'; readonly condition: Expression; readonly body: readonly Statement[] }
  | { readonly kind: 'foreach'; readonly header: Expression; readonly body: readonly Statement[] }
  | { readonly kind: 'break' | 'continue' } | { readonly kind: 'unsupported'; readonly reason: string }
);
interface FunctionEntry { readonly kind: 'resource' | 'remote' | 'function' | 'method'; readonly name: string; readonly signature: string; readonly parameters: readonly { readonly kind: 'input' | 'path'; readonly text: string }[]; readonly returnType: string; }
interface FunctionModel extends Located { readonly moduleId: Id; readonly entry: FunctionEntry; readonly body: readonly Statement[]; }
interface ProgramModel { readonly scopes: readonly ScopeModel[]; readonly functions: Readonly<Record<Id, FunctionModel>>; }
export type ExpansionPath = string;
export interface DiagramNode { readonly id: Id; readonly kind: 'step' | 'condition' | 'function' | 'loop' | 'mapping' | 'unsupported' | 'return' | 'client' | 'trap' | 'panic' | 'template'; readonly client?: ClientInvocation; readonly contextExpanded?: boolean; readonly contextPath?: string; readonly selection: Located; readonly label: string; readonly children: readonly DiagramNode[]; }
export interface DiagramPort { readonly id: Id; readonly nodeId: Id; readonly role: 'entry' | 'normal-exit' | 'true' | 'false' | 'return' | 'break' | 'continue' | 'next-iteration' | 'panic'; }
export interface DiagramEdge { readonly fromPort: Id; readonly toPort: Id; readonly kind: 'sequence' | 'true' | 'false' | 'back' | 'break' | 'continue' | 'return' | 'error' | 'panic'; readonly label?: string; }
export interface Diagram { readonly nodes: readonly DiagramNode[]; readonly ports: readonly DiagramPort[]; readonly edges: readonly DiagramEdge[]; }
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface DiagramLayout { readonly diagram: Diagram; readonly boxes: Readonly<Record<Id, Box>>; readonly routes: readonly (readonly { readonly x: number; readonly y: number }[])[]; readonly width: number; readonly height: number; }
interface Fragment { nodes: DiagramNode[]; entry?: Id; normal: Id[]; returns: Id[]; breaks: Id[]; continues: Id[]; panics: Id[]; }
interface Hint { mode: 'sequence' | 'if' | 'while' | 'foreach' | 'trap'; split?: number; path?: string; unavailable?: string; recursive?: boolean; root?: boolean; }
// Layout-only hierarchy metadata accompanies an owned diagram without changing its public shape.
const hints = new WeakMap<DiagramNode, Hint>();
export function nodeHint(node: DiagramNode): Readonly<Hint> | undefined { return hints.get(node); }
export function buildDiagram(program: ProgramModel, functionId: Id, expanded: ReadonlySet<ExpansionPath>): Diagram {
  const ports: DiagramPort[] = [], edges: DiagramEdge[] = [];
  const port = (node: DiagramNode, role: DiagramPort['role']) => { const id = `${node.id}:${role}`; if (!ports.some(p => p.id === id)) ports.push({id, nodeId: node.id, role}); return id; };
  const edge = (fromPort: Id, toPort: Id | undefined, kind: DiagramEdge['kind'] = 'sequence', label?: string) => { if (toPort) edges.push({fromPort, toPort, kind, ...(label ? {label} : {})}); };
  const connect = (from: Id[], to: Id | undefined, kind: DiagramEdge['kind'] = 'sequence') => from.forEach(p => edge(p, to, kind));
  const empty = (): Fragment => ({nodes: [], normal: [], returns: [], breaks: [], continues: [], panics: []});
  const block = (statements: readonly Statement[], path: string, ancestors: readonly Id[]): Fragment => {
    const result = empty(); let previous: Id[] = [], first = true;
    for (const statement of statements) {
      const fragment = convert(statement, `${path}/${statement.id}`, ancestors);
      if (first) { result.entry = fragment.entry; first = false; }
      connect(previous, fragment.entry); previous = fragment.normal;
      result.nodes.push(...fragment.nodes); result.returns.push(...fragment.returns); result.breaks.push(...fragment.breaks); result.continues.push(...fragment.continues); result.panics.push(...fragment.panics);
    }
    result.normal = previous; return result;
  };
  const evaluate = (e: Evaluation, path: string, ancestors: readonly Id[]): Fragment => {
    const f = empty();
    const sequence = (items: readonly Evaluation[]): Fragment => {
      const result = empty(); let previous: Id[] = [];
      items.forEach((child, i) => {
        const part = evaluate(child, `${path}/part/${i}`, ancestors);
        if (i === 0) result.entry = part.entry;
        connect(previous, part.entry); previous = part.normal;
        result.nodes.push(...part.nodes); result.returns.push(...part.returns); result.panics.push(...part.panics);
      });
      result.normal = previous; return result;
    };
    if (e.kind === 'check' || e.kind === 'checkpanic') {
      const operand = sequence(e.children);
      const terminal: DiagramNode = {id: path + '/error', kind: e.kind === 'check' ? 'return' : 'panic', selection: e, label: e.kind === 'check' ? 'Return error' : 'Panic with error', children: []};
      const gate: DiagramNode = {id: path, kind: 'condition', selection: e, label: e.kind, children: [terminal]};
      hints.set(gate, {mode: 'if', split: 0}); hints.set(terminal, {mode: 'sequence'});
      const join = port(gate, 'normal-exit');
      edge(port(gate, 'true'), join, 'true', 'value');
      edge(port(gate, 'false'), port(terminal, 'entry'), 'error', 'error');
      connect(operand.normal, port(gate, 'entry'));
      f.nodes = [...operand.nodes, gate]; f.entry = operand.entry ?? port(gate, 'entry'); f.normal = [join];
      f.returns = [...operand.returns]; f.panics = [...operand.panics];
      if (e.kind === 'check') f.returns.push(port(terminal, 'return'));
      else f.panics.push(port(terminal, 'panic'));
      return f;
    }
    if (e.kind === 'trap') {
      const operand = sequence(e.children);
      const capture: DiagramNode = {id: path + '/capture', kind: 'step', selection: e, label: 'Capture panic as error value', children: []};
      const node: DiagramNode = {id: path, kind: 'trap', selection: e, label: 'trap', children: [...operand.nodes, capture]};
      hints.set(node, {mode: 'trap'}); hints.set(capture, {mode: 'sequence'});
      const exit = port(node, 'normal-exit');
      edge(port(node, 'entry'), operand.entry ?? exit);
      connect(operand.normal, exit);
      operand.panics.forEach(p => edge(p, port(capture, 'entry'), 'panic', 'panic'));
      edge(port(capture, 'normal-exit'), exit, 'sequence', 'error value');
      f.nodes = [node]; f.entry = port(node, 'entry'); f.normal = [exit]; f.returns = operand.returns;
      return f;
    }
    const nested = sequence(e.kind === 'template' ? e.children.filter(child => child.kind !== 'source' || child.children.length > 0) : e.children);
    const client = e.call?.client;
    const contextExpanded = expanded.has(path + '/context');
    const context = client ? client.context.initializer?.text ?? (client.context.origin === 'parameter' ? 'Parameter' : 'Initialization not statically known') : '';
    const summary = contextExpanded || context.length <= 90 ? context : context.slice(0, 87) + '…';
    const method = client ? (client.method.startsWith('->') ? client.method : `→ ${client.method}(${client.arguments.map(a => a.text).join(', ')})`) : '';
    const label = client ? `${client.context.receiver.text}${client.context.type ? ` · ${client.context.type}` : ''}\n${summary}\n${method}` : e.text;
    const node: DiagramNode = {id: path, kind: client ? 'client' : e.kind === 'template' ? 'template' : e.call?.target.kind === 'workspace' ? 'function' : 'step', selection: e.call ?? e, label, children: [], ...(client ? {client, contextExpanded, ...(context.length > 90 ? {contextPath: path + '/context'} : {})} : {})};
    hints.set(node, {mode: 'sequence'});
    f.nodes = [...nested.nodes, node]; f.entry = nested.entry ?? port(node, 'entry');
    connect(nested.normal, port(node, 'entry'));
    f.normal = [port(node, 'normal-exit')]; f.returns = nested.returns; f.panics = [...nested.panics, port(node, 'panic')];
    // Keep workspace expansion available inside operators and interpolations.
    if (e.call?.target.kind === 'workspace') {
      const call = e.call, target = program.functions[e.call.target.functionId];
      const recursive = !!target && ancestors.includes(target.id), callPath = path + '/expand';
      const unavailable = !target ? 'Function body is unavailable.' : recursive ? 'Recursive calls remain collapsed.' : call.expansion === 'unavailable' ? call.reason : undefined;
      hints.set(node, {mode: 'sequence', path: callPath, unavailable, recursive});
      if (expanded.has(callPath) && !unavailable && target) {
        const body = block(target.body, callPath, [...ancestors, target.id]);
        (node.children as DiagramNode[]).push(...body.nodes);
        edge(port(node, 'entry'), body.entry ?? port(node, 'normal-exit'));
        connect([...body.normal, ...body.returns], port(node, 'normal-exit'), 'return');
        f.panics = [...nested.panics, port(node, 'panic'), ...body.panics];
        if (body.entry && !body.normal.length && !body.returns.length) f.normal = [];
      }
    }
    return f;
  };
  const convert = (s: Statement, path: string, ancestors: readonly Id[]): Fragment => {
    const f = empty();
    const children: DiagramNode[] = [];
    const node: DiagramNode = {id: path, kind: s.kind === 'return' ? 'return' : s.kind === 'if' ? 'condition' : s.kind === 'while' || s.kind === 'foreach' ? 'loop' : s.kind === 'unsupported' ? 'unsupported' : s.kind === 'simple' && s.presentation === 'mapping' ? 'mapping' : 'step', selection: s.kind === 'if' || s.kind === 'while' ? s.condition : s.kind === 'foreach' ? s.header : s, label: s.kind === 'if' || s.kind === 'while' ? s.condition.text : s.kind === 'foreach' ? `foreach ${s.header.text}` : s.text, children};
    hints.set(node, {mode: 'sequence', ...(s.kind === 'unsupported' ? {unavailable: s.reason} : {})});
    f.nodes.push(node); f.entry = port(node, 'entry');
    if (s.kind === 'unsupported') return f;
    const evaluation = s.evaluation ?? (s.kind === 'if' || s.kind === 'while' ? s.condition.evaluation : s.kind === 'foreach' ? s.header.evaluation : undefined);
    if (evaluation && (s.kind === 'simple' || s.kind === 'return')) {
      const evaluated = evaluate(evaluation, path + '/evaluation', ancestors);
      const completion: DiagramNode = {...node, label: s.kind === 'return' ? 'Return value' : s.binding ? `Result → ${s.binding}` : s.text};
      hints.set(completion, {mode: 'sequence'});
      connect(evaluated.normal, port(completion, 'entry'));
      return {...evaluated, nodes: [...evaluated.nodes, completion], entry: evaluated.entry ?? port(completion, 'entry'),
        normal: s.kind === 'return' ? [] : [port(completion, 'normal-exit')],
        returns: [...evaluated.returns, ...(s.kind === 'return' ? [port(completion, 'return')] : [])]};
    }
    if (s.kind === 'break') { f.breaks.push(port(node, 'break')); return f; }
    if (s.kind === 'continue') { f.continues.push(port(node, 'continue')); return f; }
    if (evaluation && (s.kind === 'if' || s.kind === 'while' || s.kind === 'foreach')) {
      const evaluated = evaluate(evaluation, path + '/evaluation', ancestors);
      f.nodes.unshift(...evaluated.nodes); f.entry = evaluated.entry ?? f.entry;
      connect(evaluated.normal, port(node, 'entry'));
      f.returns.push(...evaluated.returns); f.panics.push(...evaluated.panics);
    }
    if (s.kind === 'if') {
      const a = block(s.thenBody, path + '/then', ancestors), b = block(s.elseBody, path + '/else', ancestors);
      children.push(...a.nodes, ...b.nodes); hints.set(node, {mode: 'if', split: a.nodes.length});
      const join = port(node, 'normal-exit');
      edge(port(node, 'true'), a.entry ?? join, 'true'); edge(port(node, 'false'), b.entry ?? join, 'false');
      connect(a.normal, join); connect(b.normal, join);
      f.normal = a.entry && b.entry && !a.normal.length && !b.normal.length ? [] : [join];
      f.panics.push(...a.panics, ...b.panics); f.returns.push(...a.returns, ...b.returns); f.breaks.push(...a.breaks, ...b.breaks); f.continues.push(...a.continues, ...b.continues); return f;
    }
    if (s.kind === 'while' || s.kind === 'foreach') {
      const body = block(s.body, path + '/loop', ancestors); children.push(...body.nodes); hints.set(node, {mode: s.kind});
      const exit = port(node, 'normal-exit'); f.normal = [exit];
      const iteration = s.kind === 'while' ? f.entry : port(node, 'next-iteration');
      edge(port(node, 'true'), body.entry ?? iteration, s.kind === 'while' ? 'true' : 'sequence'); if (s.kind === 'while') edge(port(node, 'false'), exit, 'false');
      connect(body.normal, iteration, s.kind === 'while' ? 'back' : 'sequence'); connect(body.continues, iteration, 'continue'); connect(body.breaks, exit, 'break'); f.returns.push(...body.returns); f.panics.push(...body.panics); return f;
    }
    let normal = port(node, 'normal-exit');
    const calls = 'calls' in s ? s.calls : [];
    for (const call of calls) {
      // Library calls are already represented by the statement's source label.
      // Only workspace functions have bodies that can be disclosed in the flow.
      if (call.target.kind === 'external') continue;
      const callPath = `${path}/expand/${call.id}`;
      const target = call.target.kind === 'workspace' ? program.functions[call.target.functionId] : undefined;
      const recursive = !!target && ancestors.includes(target.id);
      const unavailable = call.expansion === 'unavailable' ? call.reason : !target ? 'Function body is unavailable.' : recursive ? 'Recursive calls remain collapsed.' : undefined;
      const callNode: DiagramNode = {id: callPath, kind: 'function', selection: call, label: call.text, children: []};
      hints.set(callNode, {mode: 'sequence', path: callPath, unavailable, recursive});
      children.push(callNode);
      if (call.expansion === 'supported') {
        if (normal) edge(normal, port(callNode, 'entry'));
        const completion = port(callNode, 'normal-exit');
        if (expanded.has(callPath) && !unavailable && target) {
          const body = block(target.body, callPath, [...ancestors, target.id]); (callNode.children as DiagramNode[]).push(...body.nodes);
          // Returns from this definition body stop at this call's continuation.
          edge(port(callNode, 'entry'), body.entry ?? completion);
          connect([...body.normal, ...body.returns], completion, 'return');
          normal = body.entry && !body.normal.length && !body.returns.length ? '' : completion;
        } else normal = completion;
      }
    }
    if (s.kind === 'return') { if (normal) { if (normal !== `${node.id}:normal-exit`) edge(normal, port(node, 'return'), 'return'); f.returns = [port(node, 'return')]; } }
    else f.normal = normal ? [normal] : [];
    return f;
  };
  const fn = program.functions[functionId]; if (!fn) return {nodes: [], ports: [], edges: []};
  const fragment = block(fn.body, functionId, [functionId]);
  const root: DiagramNode = {id: `${functionId}/root`, kind: 'function', selection: fn, label: '', children: fragment.nodes};
  hints.set(root, {mode: 'sequence', root: true});
  edge(port(root, 'entry'), fragment.entry ?? port(root, 'normal-exit'));
  connect(fragment.normal, port(root, 'normal-exit'));
  // Top-level returns terminate here; expanded callees keep their own continuation edges.
  return {nodes: [root], ports, edges};
}

export function layoutDiagram<D extends Diagram>(diagram: D, measure: (label: string) => {width: number; height: number}): Omit<DiagramLayout, 'diagram'> & {readonly diagram: D} {
  const layoutHint = (node: DiagramNode): Readonly<Hint> | undefined => hints.get(node);
  const boxes: Record<Id, Box> = {}, exits = new Map<Id, number>(), sizes = new Map<Id, {width: number; height: number}>();
  const gap = 52, padding = 30, lane = 48;
  const sequenceSize = (nodes: readonly DiagramNode[]) => { const dimensions = nodes.map(size); return {width: Math.max(240, ...dimensions.map(d => d.width)), height: dimensions.reduce((h, d) => h + d.height + gap, 0)}; };
  const size = (node: DiagramNode): {width: number; height: number} => {
    const label = measure(node.label), hint = layoutHint(node), header = Math.max(52, label.height + 28), own = Math.max(240, Math.min(440, label.width + 72));
    let result: {width: number; height: number};
    if (hint?.mode === 'if') {
      const left = sequenceSize(node.children.slice(0, hint.split)), right = sequenceSize(node.children.slice(hint.split));
      result = {width: Math.max(left.width + right.width + lane * 2, left.width + own + lane, right.width + own + lane), height: header + Math.max(left.height, right.height) + gap * 2};
    } else if (node.children.length) { const child = sequenceSize(node.children); result = {width: Math.max(own, child.width + padding * 2 + lane * 2), height: (hint?.root ? 0 : header + gap) + child.height + padding + gap}; }
    else result = {width: own, height: header};
    sizes.set(node.id, result); return result;
  };
  diagram.nodes.forEach(size);
  const placeSequence = (nodes: readonly DiagramNode[], x: number, y: number, width: number) => { for (const node of nodes) { const s = sizes.get(node.id)!; place(node, x + (width - s.width) / 2, y); y += s.height + gap; } };
  const place = (node: DiagramNode, x: number, y: number) => {
    const s = sizes.get(node.id)!, hint = layoutHint(node), header = Math.max(52, measure(node.label).height + 28);
    const conditionWidth = Math.max(240, Math.min(440, measure(node.label).width + 72));
    boxes[node.id] = hint?.mode === 'if' ? {x: x + (s.width - conditionWidth) / 2, y, width: conditionWidth, height: header} : {x, y, ...s};
    exits.set(node.id, y + s.height);
    if (hint?.mode === 'if') {
      const leftNodes = node.children.slice(0, hint.split), rightNodes = node.children.slice(hint.split), left = sequenceSize(leftNodes), right = sequenceSize(rightNodes);
      placeSequence(leftNodes, x, y + header + gap, left.width);
      placeSequence(rightNodes, x + s.width - right.width, y + header + gap, right.width);
    } else placeSequence(node.children, x + padding + lane, y + (hint?.root ? 0 : header + gap), s.width - 2 * (padding + lane));
  };
  const total = sequenceSize(diagram.nodes); placeSequence(diagram.nodes, 40, 40, total.width);
  const portMap = new Map(diagram.ports.map(p => [p.id, p]));
  const point = (id: Id) => {
    const p = portMap.get(id)!; const b = boxes[p.nodeId], node = findNode(diagram.nodes, p.nodeId)!, hint = layoutHint(node);
    if (p.role === 'entry') return {x: b.x + b.width / 2, y: b.y - (hint?.root ? 24 : 0)};
    if (p.role === 'next-iteration') return {x: b.x + b.width / 2 - 70, y: b.y + b.height - 28};
    if (p.role === 'true') return hint?.mode === 'foreach'
      ? {x: b.x + b.width / 2, y: b.y + Math.max(52, measure(node.label).height + 28)}
      : {x: b.x, y: b.y + Math.max(52, measure(node.label).height + 28) / 2};
    if (p.role === 'panic') return {x: b.x + b.width, y: b.y + Math.max(52, measure(node.label).height + 28) / 2};
    if (p.role === 'false') return {x: b.x + b.width, y: b.y + Math.max(52, measure(node.label).height + 28) / 2};
    if (p.role === 'normal-exit' && hint?.mode === 'if') return {x: b.x + b.width / 2, y: exits.get(p.nodeId)!};
    if (p.role === 'normal-exit' && node.children.length && !hint?.path && !hint?.root && node.kind !== 'loop' && node.kind !== 'trap') return {x: b.x + b.width / 2, y: b.y + Math.max(52, measure(node.label).height + 28)};
    return {x: b.x + b.width / 2, y: b.y + b.height};
  };
  const parents = new Map<Id, Id>();
  const collectParents = (nodes: readonly DiagramNode[]) => { for (const node of nodes) { for (const child of node.children) parents.set(child.id, node.id); collectParents(node.children); } }; collectParents(diagram.nodes);
  const ancestor = (a: Id, id: Id) => { for (let p = parents.get(id); p; p = parents.get(p)) if (p === a) return true; return false; };
  const obstacles = [...sizes.keys()].map(id => {
    const node = findNode(diagram.nodes, id)!, box = boxes[id];
    return {id, box: {...box, height: Math.max(52, measure(node.label).height + 28)}, root: layoutHint(node)?.root};
  }).filter(o => !o.root);
  const routes = diagram.edges.map(e => {
    const a = point(e.fromPort), b = point(e.toPort), from = portMap.get(e.fromPort)!, to = portMap.get(e.toPort)!, box = boxes[to.nodeId];
    let preferred: {x: number; y: number}[];
    const routing = e.kind === 'back' || e.kind === 'continue' && b.y < a.y ? 'back' : e.kind === 'true' ? 'branch-left' : e.kind === 'false' || e.kind === 'error' ? 'branch-right' : 'direct';
    if (routing === 'back') { const x = box.x - lane / 2; preferred = [a, {x: a.x, y: a.y + 18}, {x, y: a.y + 18}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]; }
    else if (routing === 'branch-left' || routing === 'branch-right') {
      const outward = routing === 'branch-left' ? b.x < a.x : b.x > a.x;
      if (outward && b.y > a.y) preferred = [a, {x: b.x, y: a.y}, b];
      else { const x = a.x + (routing === 'branch-left' ? -24 : 24); preferred = [a, {x, y: a.y}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]; }
    }
    else if (a.x === b.x) preferred = [a, b];
    else preferred = [a, {x: a.x, y: a.y + Math.max(16, (b.y - a.y) / 2)}, {x: b.x, y: a.y + Math.max(16, (b.y - a.y) / 2)}, b];
    const blocked = obstacles.filter(o => o.id !== from.nodeId && o.id !== to.nodeId).map(o => ({...o, box: ancestor(o.id, from.nodeId) || ancestor(o.id, to.nodeId) ? o.box : boxes[o.id]}));
    const clear = (route: {x: number; y: number}[]) => route.every((p, i) => i === 0 || blocked.every(({box: r}) => {
      const prev = route[i - 1];
      return p.x === prev.x ? p.x <= r.x || p.x >= r.x + r.width || Math.max(prev.y, p.y) <= r.y || Math.min(prev.y, p.y) >= r.y + r.height : p.y <= r.y || p.y >= r.y + r.height || Math.max(prev.x, p.x) <= r.x || Math.min(prev.x, p.x) >= r.x + r.width;
    }));
    if (clear(preferred)) return preferred;
    const candidates = [a.y + 18, b.y - 18, ...blocked.flatMap(o => [o.box.y - 18, o.box.y + o.box.height + 18])].map(y => [a, {x: a.x, y}, {x: b.x, y}, b]);
    for (const x of [20, total.width + 70, ...blocked.flatMap(o => [o.box.x - 18, o.box.x + o.box.width + 18])]) candidates.push([a, {x: a.x, y: a.y + 18}, {x, y: a.y + 18}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]);
    const length = (route: {x: number; y: number}[]) => route.reduce((sum, p, i) => i ? sum + Math.abs(p.x - route[i-1].x) + Math.abs(p.y - route[i-1].y) : sum, 0);
    return candidates.filter(clear).sort((a,b) => length(a) - length(b))[0] ?? routeAround(a, b, blocked.map(o => o.box), total.width + 88, total.height + 88);
  });
  const simplified = routes.map(route => route.filter((p, i) => i === 0 || p.x !== route[i-1].x || p.y !== route[i-1].y).filter((p, i, points) => i === 0 || i === points.length-1 || !(points[i-1].x === p.x && p.x === points[i+1].x || points[i-1].y === p.y && p.y === points[i+1].y)));
  return {diagram, boxes, routes: simplified, width: total.width + 100, height: total.height + 100};
}
function findNode(nodes: readonly DiagramNode[], id: Id): DiagramNode | undefined { for (const n of nodes) { if (n.id === id) return n; const child = findNode(n.children, id); if (child) return child; } return undefined; }

// Sparse orthogonal search is used when a branch/loop needs more than two bends.
function routeAround(start: {x: number; y: number}, end: {x: number; y: number}, obstacles: Box[], width: number, height: number): {x: number; y: number}[] {
  const axis = (points: number[]) => [...new Set(points)].sort((a,b) => a-b);
  const xs = axis([start.x,end.x,8,width,...obstacles.flatMap(b => [Math.max(8,b.x-18),b.x+b.width+18])]);
  const ys = axis([start.y,end.y,8,height,...obstacles.flatMap(b => [Math.max(8,b.y-18),b.y+b.height+18])]);
  const index = (x: number,y: number) => y*xs.length+x;
  const first = index(xs.indexOf(start.x),ys.indexOf(start.y)), target = index(xs.indexOf(end.x),ys.indexOf(end.y));
  const point = (i: number) => ({x:xs[i%xs.length],y:ys[Math.floor(i/xs.length)]});
  const clear = (a: {x:number;y:number},b: {x:number;y:number}) => obstacles.every(r => a.x === b.x ? a.x <= r.x || a.x >= r.x+r.width || Math.max(a.y,b.y) <= r.y || Math.min(a.y,b.y) >= r.y+r.height : a.y <= r.y || a.y >= r.y+r.height || Math.max(a.x,b.x) <= r.x || Math.min(a.x,b.x) >= r.x+r.width);
  const costs = new Map([[first,0]]), previous = new Map<number,number>(), pending=[{id:first,score:0}], done=new Set<number>();
  while (pending.length) {
    pending.sort((a,b) => b.score-a.score); const current = pending.pop()!.id;
    if (done.has(current)) continue; done.add(current);
    if (current === target) {
      const path=[end]; for(let at=target;at!==first;){at=previous.get(at)!;path.push(point(at));} path.reverse();
      return path.filter((p,i) => i===0 || i===path.length-1 || !(path[i-1].x===p.x&&p.x===path[i+1].x || path[i-1].y===p.y&&p.y===path[i+1].y));
    }
    const x=current%xs.length,y=Math.floor(current/xs.length),a=point(current);
    for (const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
      if(nx<0||ny<0||nx>=xs.length||ny>=ys.length)continue;
      const id=index(nx,ny),b=point(id);if(!clear(a,b))continue;
      const cost=costs.get(current)!+Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
      if(cost >= (costs.get(id) ?? Infinity))continue;
      costs.set(id,cost);previous.set(id,current);pending.push({id,score:cost+Math.abs(b.x-end.x)+Math.abs(b.y-end.y)});
    }
  }
  throw new Error('The flow layout could not route an execution edge around source nodes.');
}

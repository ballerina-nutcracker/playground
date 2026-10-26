import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instantiateGraph } from '../../src/components/bal-bot/hir-flow.ts';
import { layoutDiagram } from '../../src/components/bal-bot/flow.ts';
import { validateHIR } from '../../../../packages/compiler/src/protocol.ts';

const fixtures = new URL('../../../../packages/compiler/testdata/upstream/tests/fixtures/hir-contract/', import.meta.url);
const json = async file => JSON.parse(await readFile(new URL(file, fixtures), 'utf8'));
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);
const measure = label => ({ width: label.length * 8, height: 16 });
function paths(program, id, occurrence = id, ancestors = [id]) {
  return program.functions[id].nodes.flatMap(node => {
    if (node.body.kind !== 'reference') return [];
    const ref = node.body.reference;
    if (ref.availability.kind !== 'available' || ancestors.includes(ref.graphId)) return [];
    const path = occurrence + ref.occurrenceKey;
    return [path, ...paths(program, ref.graphId, path, [...ancestors, ref.graphId])];
  });
}
function states(paths) {
  // Exhaust small interacting graphs. The symbolic 24-independent-reference
  // stress fixture gets both joint extremes and each reference toggled alone
  // in both directions, rather than enumerating sixteen million subsets.
  if (paths.length <= 8) return Array.from({ length: 2 ** paths.length }, (_, mask) => new Set(paths.filter((_, i) => mask & 2 ** i)));
  return [new Set(), new Set(paths), ...paths.flatMap(path => [new Set([path]), new Set(paths.filter(other => other !== path))])];
}
function check(program, id, expanded) {
  const diagram = instantiateGraph(program, id, expanded);
  const streams = JSON.stringify([diagram.nodes, diagram.ports, diagram.edges]);
  const layout = layoutDiagram(diagram, measure);
  assert.equal(JSON.stringify([diagram.nodes, diagram.ports, diagram.edges]), streams, 'layout must not alter emission or transparent hierarchy');
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  const ports = new Set(diagram.ports.map(port => port.id));
  for (const port of diagram.ports) {
    const box = layout.boxes[port.nodeId];
    assert.ok(box, `missing active owner ${port.nodeId}`);
    assert.ok(Object.values(box).every(Number.isFinite), `nonfinite owner ${port.nodeId}`);
  }
  assert.equal(layout.routes.length, diagram.edges.length);
  for (const edge of diagram.edges) assert.ok(ports.has(edge.fromPort) && ports.has(edge.toPort), 'active edge endpoints must remain emitted');
  for (const route of layout.routes) for (const point of route) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  return { diagram, layout };
}

// Use an accepted reference fixture, retaining its active ports and edges.
async function columnProgram(nested = false) {
  const program = await json('expandable-function-reference.json');
  const graph = program.functions.target;
  const style = structuredClone(program.functions.main.nodes[0].body.reference.container);
  const owner = { id: 'hidden', occurrenceKey: '/hidden', sourceId: 'source-a', presentation: { kind: 'hidden' }, body: { kind: 'group', groupId: 'columns' } };
  graph.nodes.unshift(owner);
  graph.groups[0].arrangement.members = ['hidden'];
  graph.groups.push({ id: 'columns', arrangement: { kind: 'columns', left: ['a'], right: ['b'] }, style });
  if (nested) {
    graph.nodes.push({ ...structuredClone(owner), id: 'outer', occurrenceKey: '/outer', body: { kind: 'group', groupId: 'outer-columns' } });
    graph.nodes.push({ ...structuredClone(graph.nodes.find(n => n.id === 'b')), id: 'c', occurrenceKey: '/c' });
    graph.groups[0].arrangement.members = ['outer'];
    graph.groups.push({ id: 'outer-columns', arrangement: { kind: 'columns', left: ['hidden'], right: ['c'] }, style });
    for (const plan of Object.values(graph.emission)) plan.nodes.push({ kind: 'local', itemId: 'c', when: { kind: 'constant', value: true } });
  }
  validateHIR(program);
  return program;
}

function assertColumns(layout, prefix) {
  const left = layout.boxes[prefix + 'a'], right = layout.boxes[prefix + 'b'];
  assert.equal(left.y, right.y, 'hidden owner must retain parallel columns');
  assert.ok(left.x + left.width < right.x, 'declared columns must stay separate');
}

test('hidden column owner retains the existing numeric column placement without emitting a node', async () => {
  const program = await columnProgram();
  const { diagram, layout } = check(program, 'target', new Set());
  assert.deepEqual(flatten(diagram.nodes).map(node => node.id), ['targeta', 'targetb']);
  assertColumns(layout, 'target');
  assert.deepEqual(layout.boxes.targeta, { x: 40, y: 144, width: 240, height: 52 });
  assert.deepEqual(layout.boxes.targetb, { x: 376, y: 144, width: 240, height: 52 });
  assert.equal(layout.width, 676);
  assert.equal(layout.height, 412);
});

test('group node visibility does not discard its explicit arrangement', async () => {
  const program = await columnProgram();
  const graph = program.functions.target;
  graph.nodes[0].presentation = { ...structuredClone(graph.nodes[1].presentation), label: '' };
  const style = graph.groups.find(group => group.id === 'columns').style;
  style.root = style.inline = { node: false, header: false, container: false };
  validateHIR(program);
  const { diagram, layout } = check(program, 'target', new Set());
  assert.deepEqual(flatten(diagram.nodes).map(node => node.id), ['targeta', 'targetb']);
  assertColumns(layout, 'target');
  assert.deepEqual(layout.boxes.targeta, { x: 40, y: 144, width: 240, height: 52 });
  assert.deepEqual(layout.boxes.targetb, { x: 376, y: 144, width: 240, height: 52 });
});

test('nested hidden columns retain both levels of layout ownership', async () => {
  const { diagram, layout } = check(await columnProgram(true), 'target', new Set());
  assert.deepEqual(flatten(diagram.nodes).map(node => node.id), ['targeta', 'targetb', 'target/c']);
  assertColumns(layout, 'target');
  assert.equal(layout.boxes.targeta.y, 248);
  assert.ok(layout.boxes.targetb.x + 240 < layout.boxes['target/c'].x);
  assert.equal(layout.boxes['target/c'].y, 144);
});

test('inline hidden columns retain occurrence-local carriers and independent expansion', async () => {
  const program = await columnProgram(true);
  const graph = program.functions.main;
  const second = structuredClone(graph.nodes[0]);
  second.id = 'second'; second.occurrenceKey = '/second'; second.body.reference.occurrenceKey = '/second';
  graph.nodes.push(second);
  graph.groups[0].arrangement.members.push('second');
  for (const plan of Object.values(graph.emission)) {
    plan.nodes.push(
      { kind: 'local', itemId: 'second', when: { kind: 'constant', value: true } },
      { kind: 'child', referenceNodeId: 'second', when: { kind: 'constant', value: true } },
    );
    for (const stream of ['ports', 'edges']) plan[stream].push({ kind: 'child', referenceNodeId: 'second', when: { kind: 'constant', value: true } });
  }
  validateHIR(program);
  for (const expanded of [new Set(['maina']), new Set(['main/second']), new Set(['maina', 'main/second'])]) {
    const { diagram, layout } = check(program, 'main', expanded);
    for (const path of expanded) assertColumns(layout, path);
    assert.ok(flatten(diagram.nodes).every(node => !node.id.endsWith('/hidden') && !node.id.endsWith('/outer')));
    assert.deepEqual(layoutDiagram(structuredClone(diagram), measure).boxes, layout.boxes);
  }
});

test('every accepted HIR contract fixture lays out active endpoints, including transparent owners', async () => {
  const manifest = await json('cases.json');
  for (const fixture of manifest.cases.filter(fixture => fixture.accept)) {
    const program = await json(fixture.file);
    validateHIR(program);
    for (const id of Object.keys(program.functions)) for (const expanded of states(paths(program, id))) {
      try { check(program, id, expanded); }
      catch (error) { throw new Error(`${fixture.name} / ${id} / ${[...expanded].join(',')}`, { cause: error }); }
    }
  }
});

test('transparent leaf, descendant and binding owners retain streams and derive anchors from placed structure', async () => {
  let hidden = 0;
  for (const name of ['reference-container-conditional-visibility', 'child-nodes-empty-slice-after-sibling', 'child-nodes-hidden-target-with-visible-descendants', 'binding-hidden-child-conditioned']) {
    const program = await json(`${name}.json`);
    for (const id of Object.keys(program.functions)) for (const expanded of states(paths(program, id))) {
      const { diagram, layout } = check(program, id, expanded);
      const visible = new Set(flatten(diagram.nodes).map(node => node.id));
      const before = JSON.stringify(layout.boxes);
      for (const port of diagram.ports) if (!visible.has(port.nodeId)) {
        hidden++;
        assert.ok(diagram.geometry.nodes.some(node => node.id === port.nodeId));
        assert.ok(layout.boxes[port.nodeId]);
      }
      // Anchor synthesis is not driven by endpoint first-use order.
      const reordered = { ...diagram, ports: [...diagram.ports].reverse() };
      assert.deepEqual(layoutDiagram(reordered, measure).boxes, JSON.parse(before));
      // It is explicit render-local data, not identity-bound cached geometry.
      assert.deepEqual(layoutDiagram(structuredClone(diagram), measure).boxes, layout.boxes);
    }
  }
  assert.ok(hidden > 0);
});

// Explicit declared arrangement completeness.
const load = async () => JSON.parse(await readFile(new URL('../../../../packages/compiler/testdata/upstream/tests/fixtures/hir-contract/expandable-function-reference.json', import.meta.url), 'utf8'));
const yes = { kind: 'constant', value: true };
function emissions(graph) {
  const visit = id => {
    const group = graph.groups.find(g => g.id === id), a = group.arrangement;
    return (a.kind === 'columns' ? [...a.left, ...a.right] : a.members).flatMap(id => {
      const node = graph.nodes.find(n => n.id === id);
      return [...(node.presentation.kind === 'hidden' ? [] : [{ kind: 'local', itemId: id, when: yes }]), ...(node.body.kind === 'group' ? visit(node.body.groupId) : [])];
    });
  };
  for (const plan of Object.values(graph.emission)) plan.nodes = visit(graph.rootGroup);
}
function owner(graph, id, left, right, hidden = true) {
  const template = graph.nodes.find(n => n.body.kind === 'leaf');
  const style = structuredClone(graph.groups[0].style);
  graph.nodes.push({ ...structuredClone(template), id, occurrenceKey: '/' + id, presentation: hidden ? { kind: 'hidden' } : structuredClone(template.presentation), body: { kind: 'group', groupId: id + '-group' } });
  graph.groups.push({ id: id + '-group', style, arrangement: { kind: 'columns', left, right } });
  for (const plan of Object.values(graph.emission)) plan.nodes.push({ kind: 'local', itemId: id, when: yes });
}
function parallel(layout, prefix, a, b) {
  const left = layout.boxes[prefix + a], right = layout.boxes[prefix + b];
  assert.equal(left.y, right.y);
  assert.ok(left.x + left.width < right.x);
}
for (const mode of ['root', 'inline', 'hidden-parent']) test(`ownerless ${mode} columns use declared arrangement`, async () => {
  const inline = mode !== 'root';
  const program = await load(), graph = program.functions.target;
  if (mode === 'hidden-parent') {
    program.functions.main.nodes[0].presentation = { kind: 'hidden' };
    const style = program.functions.main.nodes[0].body.reference.container;
    style.root = style.inline = { node: false, header: false, container: false };
    for (const plan of Object.values(program.functions.main.emission)) plan.nodes = plan.nodes.filter(slot => slot.kind !== 'local' || slot.itemId !== 'a');
  }
  graph.groups[0].arrangement = { kind: 'columns', left: ['b'], right: ['a'] };
  emissions(graph);
  validateHIR(program);
  const diagram = instantiateGraph(program, inline ? 'main' : 'target', new Set(inline ? ['maina'] : []));
  const layout = layoutDiagram(diagram, measure);
  parallel(layout, inline ? 'maina' : 'target', 'b', 'a');
  assert.equal(flatten(diagram.nodes).some(n => n.id.startsWith('[')), false, 'root group carriers never enter emission');
  if (mode === 'hidden-parent') assert.equal(flatten(diagram.nodes).some(n => n.id === 'maina'), false);
});
test('hidden carrier uses group order rather than declaration order', async () => {
  const program = await load(), graph = program.functions.target;
  owner(graph, 'hidden', ['b'], ['a']);
  graph.groups[0].arrangement.members = ['hidden'];
  // Node declarations deliberately retain a,b order, opposite group order.
  emissions(graph);
  validateHIR(program);
  const diagram = instantiateGraph(program, 'target', new Set());
  const before = JSON.stringify(diagram.nodes);
  const reordered = { ...diagram, geometry: { ...diagram.geometry, nodes: [...diagram.geometry.nodes].reverse() } };
  parallel(layoutDiagram(reordered, measure), 'target', 'b', 'a');
  assert.equal(JSON.stringify(diagram.nodes), before);
});
test('unrelated hidden carrier cannot reinterpret a visible effective split', async () => {
  const program = await load(), graph = program.functions.target;
  const leaf = graph.nodes[0];
  for (const id of ['c', 'd']) {
    graph.nodes.push({ ...structuredClone(leaf), id, occurrenceKey: '/' + id });
    for (const plan of Object.values(graph.emission)) plan.nodes.push({ kind: 'local', itemId: id, when: yes });
  }
  graph.nodes.find(n => n.id === 'b').presentation = { kind: 'hidden' };
  owner(graph, 'visible', ['b', 'd'], ['c'], false);
  owner(graph, 'hidden', ['a'], []);
  graph.groups[0].arrangement.members = ['visible', 'hidden'];
  emissions(graph);
  validateHIR(program);
  const diagram = instantiateGraph(program, 'target', new Set());
  const visible = diagram.nodes.find(n => n.id === 'target/visible');
  assert.equal(visible.layout.split, 1);
  const effective = { ...diagram, geometry: { ...diagram.geometry, nodes: diagram.geometry.nodes.map(n => n.id === visible.id ? visible : n) } };
  parallel(layoutDiagram(effective, measure), 'target', '/d', '/c');
});

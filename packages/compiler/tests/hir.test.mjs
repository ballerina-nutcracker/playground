import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHIR } from '../src/protocol.ts';

// Share exact JSON bytes and expectations with TestHIRSharedContract in Go.
// Node's native TS loader is also used by the adjacent compiler client tests.
const root = new URL('../testdata/upstream/tests/fixtures/hir-contract/', import.meta.url);
const corpus = JSON.parse(await readFile(new URL('cases.json', root), 'utf8'));
assert.ok(corpus.cases.length > 0, 'empty HIR corpus');

test('HIR scalar Unicode contract', async () => {
  const base = JSON.parse(await readFile(new URL('minimal.json', root), 'utf8'));
  const mutations = {
    file: (p, s) => { p.sources.main.source.file = s; },
    text: (p, s) => { p.sources.main.text = s; },
    moduleId: (p, s) => { p.functions.main.moduleId = s; },
    id: (p, s) => { p.sources.main.id = s; },
    sourceKey: (p, s) => { p.sources[s] = p.sources.main; },
    functionKey: (p, s) => { p.functions[s] = p.functions.main; },
  };
  for (const [site, mutate] of Object.entries(mutations)) {
    for (const bad of ['\ud800', '\udfff']) {
      const p = structuredClone(base);
      mutate(p, bad);
      assert.throws(() => validateHIR(p), /Invalid compiler HIR/, site);
      assert.throws(() => validateHIR(JSON.parse(JSON.stringify(p))), /Invalid compiler HIR/, site);
    }
  }
  for (const good of ['😀', 'literal\\ud800', '�', 'e\u0301']) {
    const p = structuredClone(base);
    for (const item of [...Object.values(p.sources), ...Object.values(p.functions)]) item.source.file = good;
    const before = JSON.stringify(p);
    validateHIR(p);
    assert.equal(JSON.stringify(p), before);
  }
  const p = structuredClone(base);
  p.functions.main.nodes[0].presentation.label = '\ud800';
  p.functions.main.nodes[0].presentation.sections[0].text = '\udfff';
  const before = JSON.stringify(p);
  validateHIR(p);
  assert.equal(JSON.stringify(p), before);
  const recursive = JSON.parse(await readFile(new URL('call-disclosure-reference-agreement.json', root), 'utf8'));
  const presentation = Object.values(recursive.functions).flatMap(g => g.nodes).map(n => n.presentation.disclosure?.recursive).find(Boolean);
  assert.ok(presentation);
  presentation.title = '\ud800';
  presentation.ariaLabel = '\udfff';
  validateHIR(recursive);
  for (const key of ['limitation', 'glyph']) {
    const old = presentation[key];
    presentation[key] = '\ud800';
    assert.throws(() => validateHIR(recursive), /Invalid compiler HIR/, key);
    presentation[key] = old;
  }
});

// Exercise the actual Go-lowered wire output, not just hand-built schema cases.
const projectRoot = new URL('../testdata/upstream/tests/fixtures/hir-projects/', import.meta.url);
const projects = JSON.parse(await readFile(new URL('manifest.json', projectRoot), 'utf8'));
for (const fixture of projects.cases.filter(fixture => fixture.hir)) {
  test(`HIR lowered corpus: ${fixture.id}`, async () => {
    const value = JSON.parse(await readFile(new URL(`${fixture.directory}/${fixture.hir}`, projectRoot), 'utf8'));
    const before = JSON.stringify(value);
    assert.equal(validateHIR(freeze(value)), value, 'validator must return the original object');
    assert.deepEqual(validateHIR(JSON.parse(before)), value);
    assert.equal(JSON.stringify(value), before, 'validator mutated Go-lowered HIR');
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('HIR suppressed inline root members need slots only for active consumers', async () => {
  const value = JSON.parse(await readFile(new URL('binding-mode-hidden-unused-interface.json', root), 'utf8'));
  const target = value.functions.target;
  // Root treatment runs in root mode only. Inline still queries the interface,
  // but deliberately has no local slot for its mode-hidden member "in".
  target.interfaces[0].root = {
    kind: 'connect', bindingId: 'finish', toPort: 'out',
    edge: { kind: 'return', label: null, routing: 'direct' },
  };
  target.emission.root.edges.push({ kind: 'binding', bindingId: 'finish', when: { kind: 'constant', value: true } });
  assert.ok(!target.emission.inline.ports.some(slot => slot.itemId === 'in'));
  validateHIR(freeze(structuredClone(value)));

  // An actual entry edge into that same inline interface must still fail.
  value.functions.main.nodes[0].body.reference.inline.push({
    kind: 'entry', id: 'consume', when: { kind: 'constant', value: true },
    callerPortId: 'out', targetInterfaceId: 'entry',
    edge: { kind: 'sequence', label: null, routing: 'direct' },
  });
  for (const mode of ['root', 'inline']) {
    value.functions.main.emission[mode].edges.push({ kind: 'binding', bindingId: 'consume', when: { kind: 'constant', value: true } });
  }
  assert.throws(() => validateHIR(freeze(value)), /active binding targets unemitted interface port/);
});

// A wall-clock guard makes accidental 2^24 expansion enumeration visible. This
// generous limit is not a microbenchmark; symbolic validation takes milliseconds.
test('HIR symbolic coverage: 24 independent references', { timeout: 10_000 }, async () => {
  const value = JSON.parse(await readFile(new URL('symbolic-24-independent-references.json', root), 'utf8'));
  const graph = value.functions.main;
  assert.equal(graph.nodes.length, 24);
  assert.ok(graph.nodes.every(node => node.body.kind === 'reference' && node.body.reference.graphId === 'target'));
  const condition = graph.edges[0].when;
  graph.edges[0].when = { kind: 'constant', value: true };
  const partition = { kind: 'local', itemId: 'all-expanded', when: { kind: 'not', operand: condition } };
  for (const mode of ['root', 'inline']) graph.emission[mode].edges.push(structuredClone(partition));
  validateHIR(freeze(structuredClone(value)));

  const original = graph.emission.root.edges;
  // Leave all child splices intact; only the all-expanded assignment is uncovered.
  graph.emission.root.edges = [...original.slice(0, -2), partition];
  assert.throws(() => validateHIR(freeze(structuredClone(value))), /Invalid compiler/);
  // Exactly that same rare assignment now emits the edge twice.
  graph.emission.root.edges = [...original, original.at(-2)];
  assert.throws(() => validateHIR(freeze(structuredClone(value))), /Invalid compiler/);
});

// Native JSON strings retain UTF-16 code units, including lone surrogates.
// Keep these tokens escaped until JSON.parse so a UTF-8 file cannot silently
// replace the very values this regression covers.
for (const [name, token, units] of [
  ['lone-high', String.raw`"\ud83d"`, [0xd83d]],
  ['lone-low', String.raw`"\ude00"`, [0xde00]],
  ['escaped-pair', String.raw`"\ud83d\ude00"`, [0xd83d, 0xde00]],
  ['literal-astral', '"😀"', [0xd83d, 0xde00]],
  ['adjacent-unpaired', String.raw`"\ud83d\ud83d\ude00\ude00"`, [0xd83d, 0xd83d, 0xde00, 0xde00]],
  ['split-pair', String.raw`"\ud83dx\ude00"`, [0xd83d, 0x78, 0xde00]],
  ['literal-backslash-u', String.raw`"\\ud83d"`, [0x5c, 0x75, 0x64, 0x38, 0x33, 0x64]],
  ['mixed-literal-and-escaped', String.raw`"\\ud83d\ud83d"`, [0x5c, 0x75, 0x64, 0x38, 0x33, 0x64, 0xd83d]],
]) {
  test(`HIR presentation UTF-16 code units: ${name}`, async () => {
    const value = JSON.parse(await readFile(new URL('minimal.json', root), 'utf8'));
    const presentation = value.functions.main.nodes[0].presentation;
    presentation.label = JSON.parse(token);
    presentation.sections[0].text = JSON.parse(token);
    const codeUnits = text => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
    assert.deepEqual(codeUnits(presentation.label), units);
    const validated = validateHIR(freeze(value));
    const roundtrip = validateHIR(JSON.parse(JSON.stringify(validated)));
    const result = roundtrip.functions.main.nodes[0].presentation;
    assert.deepEqual(codeUnits(result.label), units);
    assert.deepEqual(codeUnits(result.sections[0].text), units);
    assert.deepEqual(roundtrip, value);
  });
}

for (const field of ['label', 'section']) {
  for (const invalid of [null, false, 42, [], {}]) {
    test(`HIR presentation UTF-16 rejects ${field} ${JSON.stringify(invalid)}`, async () => {
      const value = JSON.parse(await readFile(new URL('minimal.json', root), 'utf8'));
      const presentation = value.functions.main.nodes[0].presentation;
      if (field === 'label') presentation.label = invalid;
      else presentation.sections[0].text = invalid;
      assert.throws(() => validateHIR(freeze(value)), /Invalid compiler/);
    });
  }
}

for (const fixture of corpus.cases) {
  test(`HIR shared contract: ${fixture.name} (${fixture.accept ? 'accept' : 'reject'})`, async () => {
    const value = JSON.parse(await readFile(new URL(fixture.file, root), 'utf8'));
    const before = JSON.stringify(value);
    freeze(value);
    if (!fixture.accept) {
      assert.throws(() => validateHIR(value), /Invalid compiler/, 'accepted malformed fixture or unexpected runtime failure');
    } else {
      const validated = validateHIR(value);
      assert.deepEqual(validated, value, 'validator changed wire data');
      assert.deepEqual(validateHIR(JSON.parse(JSON.stringify(validated))), value, 'round trip changed wire data');
      // Keyed-record insertion order cannot affect acceptance; ordered arrays are preserved.
      const reversed = structuredClone(value);
      for (const key of ['sources', 'functions']) {
        reversed[key] = Object.fromEntries(Object.entries(reversed[key]).reverse());
      }
      assert.deepEqual(validateHIR(freeze(reversed)), value);
    }
    assert.equal(JSON.stringify(value), before, 'validator mutated its input');
  });
}

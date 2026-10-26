import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHIR } from '../src/protocol.ts';

const root = new URL('../testdata/upstream/tests/fixtures/hir-contract/', import.meta.url);
const minimal = JSON.parse(await readFile(new URL('minimal.json', root), 'utf8'));
const recursive = JSON.parse(await readFile(new URL('call-disclosure-reference-agreement.json', root), 'utf8'));
const presentation = p => p.functions.main.nodes[0].presentation;
const recursiveLabel = p => Object.values(p.functions).flatMap(g => g.nodes).map(n => n.presentation.disclosure?.recursive).find(Boolean);
const client = structuredClone(minimal);
presentation(client).kind = 'client';
presentation(client).style = 'client';
presentation(client).disclosure = {
  kind: 'client-context', occurrenceKey: 'context',
  collapsed: { label: 'x', sections: [{ kind: 'text', text: 'x' }] },
  expanded: { label: 'x', sections: [{ kind: 'context', text: 'x' }] },
  call: null, expandedRecursive: null,
};
const recursiveClient = structuredClone(recursive);
const callNode = Object.values(recursiveClient.functions).flatMap(g => g.nodes).find(n => n.presentation.disclosure?.kind === 'call');
const call = callNode.presentation.disclosure;
callNode.presentation.disclosure = {
  kind: 'client-context', occurrenceKey: 'context',
  collapsed: { label: 'x', sections: [] }, expanded: { label: 'x', sections: [] },
  call, expandedRecursive: structuredClone(call.recursive),
};
const sites = [
  ['signature', minimal, p => p.functions.main.entry, 'signature', 'signatureVariables'],
  ['parameter', minimal, p => {
    p.functions.main.entry.parameters = [{ label: 'Input', text: 'x' }];
    return p.functions.main.entry.parameters[0];
  }, 'text'],
  ['plain label', minimal, presentation, 'label'],
  ['plain section', minimal, p => presentation(p).sections[0], 'text'],
  ['client label', client, presentation, 'label'],
  ['client section', client, p => presentation(p).sections[0], 'text'],
  ...['collapsed', 'expanded'].flatMap(mode => [
    [`${mode} label`, client, p => presentation(p).disclosure[mode], 'label'],
    [`${mode} section`, client, p => presentation(p).disclosure[mode].sections[0], 'text'],
  ]),
  ['recursive label', recursive, recursiveLabel, 'label'],
  ['recursive section', recursive, p => {
    const r = recursiveLabel(p); r.sections = [{ kind: 'text', text: 'x' }]; return r.sections[0];
  }, 'text'],
  ['expanded recursive label', recursiveClient, p => Object.values(p.functions).flatMap(g => g.nodes).find(n => n.presentation.disclosure?.kind === 'client-context').presentation.disclosure.expandedRecursive, 'label'],
];
const occurrence = (start = 0, end = 1, variableId = 'variable/😀') => ({ variableId, start, end });
for (const [name, base, select, textKey, key = 'variables'] of sites) {
  test(`variable protocol: ${name}`, () => {
    const p = structuredClone(base), target = select(p);
    target[textKey] = '😀xy'; // Four UTF-16 units, not three Unicode code points.
    const check = value => { target[key] = value; return () => validateHIR(p); };
    assert.equal(validateHIR(p), p);
    for (const good of [[], [occurrence(0, 2), occurrence(2, 3), occurrence(3, 4)], [occurrence(3, 4)]]) {
      assert.doesNotThrow(check(good));
      const encoded = JSON.stringify(p);
      assert.equal(validateHIR(p), p);
      assert.equal(JSON.stringify(p), encoded);
    }
    for (const bad of [
      null, undefined, {}, 'x', [null], [occurrence(0, 0)], [occurrence(-1, 1)],
      [occurrence(0, 5)], [occurrence(0.5, 1)], [occurrence(0, 1.5)],
      [occurrence(0, Infinity)], [occurrence(NaN, 1)], [occurrence('0', 1)],
      [occurrence(0, 1, '')], [occurrence(0, 1, '\ud800')], [occurrence(0, 1, null)],
      [occurrence(2, 3), occurrence(0, 1)], [occurrence(0, 2), occurrence(1, 3)],
      [occurrence(), occurrence()], [{ ...occurrence(), extra: true }],
      [{ start: 0, end: 1 }], [{ variableId: 'x', start: 0 }],
    ]) assert.throws(check(bad), /Invalid compiler HIR/);
    delete target[key];
    target.unrecognized = [];
    assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
    delete target.unrecognized;
    delete target[textKey];
    assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
  });
}

test('variable protocol: metadata is not accepted on hidden presentations', () => {
  const p = structuredClone(minimal);
  presentation(p).kind = 'hidden';
  p.functions.main.nodes[0].presentation = { kind: 'hidden', variables: [] };
  assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
});

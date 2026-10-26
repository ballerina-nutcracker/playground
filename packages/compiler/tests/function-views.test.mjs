import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHIR } from '../src/protocol.ts';

const base = JSON.parse(await readFile(new URL('../testdata/upstream/tests/fixtures/hir-contract/minimal.json', import.meta.url), 'utf8'));
const fixture = () => {
  const program = structuredClone(base);
  program.functionViews = structuredClone(program.functions);
  const node = program.functionViews.main.nodes.find(node => node.presentation.kind !== 'hidden');
  node.presentation.label = '😀 next(1)';
  node.calls = [{ start: 3, end: 7, targetId: 'main', unavailable: null }];
  return { program, node };
};

test('optional function views preserve legacy compatibility and UTF-16 call coordinates', () => {
  validateHIR(structuredClone(base));
  const { program, node } = fixture();
  validateHIR(program);
  assert.equal(node.presentation.label.slice(node.calls[0].start, node.calls[0].end), 'next');
  node.calls[0] = { start: 3, end: 7, targetId: null, unavailable: 'External body unavailable' };
  validateHIR(program);
});

test('optional function views and call spans are strictly validated', () => {
  const mutations = [
    ({ program }) => { program.functionViews = null; },
    ({ program }) => { program.functionViews.unknown = structuredClone(program.functionViews.main); },
    ({ program }) => { program.functionViews.main.text = 'different source'; },
    ({ node }) => { node.calls = null; },
    ({ node }) => { node.calls[0].start = -1; },
    ({ node }) => { node.calls[0].start = 3.5; },
    ({ node }) => { node.calls[0].end = 100; },
    ({ node }) => { node.calls[0].targetId = 'unknown'; },
    ({ node }) => { node.calls[0].unavailable = 'Cannot also have a target'; },
    ({ node }) => { delete node.calls[0].unavailable; },
    ({ node }) => { node.calls[0].extra = true; },
    ({ node }) => { node.calls.push({ ...node.calls[0] }); },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateHIR(value.program), /Invalid compiler HIR/);
  }
});

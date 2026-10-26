import { readFileSync } from 'node:fs';

// Instantiate actual HIR contract shapes, never convert or repair legacy models.
export function analysisResponse(fixture = 'minimal', text = 'x') {
  const program = JSON.parse(readFileSync(new URL(`../testdata/upstream/tests/fixtures/hir-contract/${fixture}.json`, import.meta.url), 'utf8'));
  for (const item of [...Object.values(program.sources), ...Object.values(program.functions)]) item.text = text;
  return { kind: 'result', operation: 'analyze', result: { kind: 'valid', diagnostics: [], program } };
}

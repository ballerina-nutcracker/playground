import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkspace } from '../src/workspace.ts';
import { workspaceTools } from '../src/agent.ts';

const sourceError = { severity: 'error', message: 'incompatible types', file: 'main.bal' };
function setup(check) {
  let writes = 0, notifications = 0;
  const workspace = new BrowserWorkspace({ getItem: () => null, setItem: () => writes++ }, { streamFn: () => { throw Error('unused'); }, compiler: { check } });
  workspace.subscribe(() => notifications++);
  const tools = workspaceTools(workspace);
  return { workspace, call: (name, args = {}, signal) => tools.find(t => t.name === name).execute('test', args, signal), counts: () => [writes, notifications] };
}
test('diagnostics use saved snapshot, forward abort, and publish no changes', async () => {
  const signal = new AbortController().signal;
  let captured;
  const { workspace, call, counts } = setup(async (files, actualSignal) => { captured = files; assert.equal(actualSignal, signal); return { diagnostics: [sourceError] }; });
  const result = await call('get_diagnostics', {}, signal);
  assert.equal(captured, workspace.snapshot());
  assert.deepEqual(result.details, { diagnostics: [sourceError], stale: false });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.deepEqual(counts(), [1, 0]);
  const tool = workspaceTools(workspace).find(t => t.name === 'get_diagnostics');
  assert.deepEqual(tool.parameters.properties, {});
});
test('edits, deletions, and editing back all make a captured check stale', async () => {
  for (const mutate of [w => w.write('main.bal', 'changed'), w => w.remove('main.bal'), w => { const old = w.read('main.bal'); w.write('main.bal', 'changed'); w.write('main.bal', old); }]) {
    let complete;
    const { workspace } = setup(() => new Promise(resolve => { complete = resolve; }));
    const pending = workspace.getDiagnostics(); mutate(workspace); complete({ diagnostics: [] });
    assert.deepEqual(await pending, { diagnostics: [], stale: true });
  }
});
test('storage-only configuration, cancellation and infrastructure failures reject', async () => {
  await assert.rejects(new BrowserWorkspace({ getItem: () => null, setItem() {} }).getDiagnostics(), /compiler/);
  let calls = 0;
  const { call } = setup(async () => { calls++; throw Error('WASM failed'); });
  await assert.rejects(call('get_diagnostics', {}, AbortSignal.abort()), { name: 'AbortError' }); assert.equal(calls, 0);
  await assert.rejects(call('get_diagnostics'), /WASM failed/);
});
test('file-tool repair sequence checks changed saved source', async () => {
  const { call } = setup(async files => ({ diagnostics: files['main.bal'].includes('bad') ? [sourceError] : [] }));
  await call('write_file', { path: 'main.bal', content: 'int x = "bad";' });
  assert.equal((await call('get_diagnostics')).details.diagnostics.length, 1);
  await call('edit_file', { path: 'main.bal', oldText: '"bad"', newText: '1' });
  assert.deepEqual((await call('get_diagnostics')).details, { diagnostics: [], stale: false });
});

test('diagnostics use browser files and become stale after a local update', async () => {
  let complete, captured;
  const workspace = new BrowserWorkspace({ getItem: () => null, setItem() {} }, {
    streamFn: () => { throw Error('unused'); },
    compiler: { check(files) { captured = files; return new Promise(resolve => { complete = resolve; }); } },
  });
  workspace.write('main.bal', 'int x = 1;');
  const pending = workspace.getDiagnostics();
  assert.equal(captured['main.bal'], 'int x = 1;');
  workspace.write('main.bal', 'int x = 2;');
  complete({ diagnostics: [] });
  assert.deepEqual(await pending, { diagnostics: [], stale: true });
  assert.equal(workspace.read('main.bal'), 'int x = 2;');
});

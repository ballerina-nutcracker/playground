import { analyze, testAgentScope } from './fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkspace, STORAGE_KEY } from '../src/workspace.ts';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('persists initial hello world files, edits and deletions across reloads', () => {
  const store = storage();
  const workspace = new BrowserWorkspace(store);
  assert.match(workspace.read('main.bal'), /Hello, World!/);
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)), workspace.snapshot());
  workspace.write('modules/example/types.bal', 'type Example string;');
  workspace.edit('main.bal', 'Hello, World!', 'hello');
  workspace.remove('Ballerina.toml');
  const restored = new BrowserWorkspace(store);
  assert.equal(restored.read('modules/example/types.bal'), 'type Example string;');
  assert.match(restored.read('main.bal'), /return "hello"/);
  assert.throws(() => restored.read('Ballerina.toml'), /not found/);
});

test('ambiguous or stale edits fail without altering source; replacement is literal', () => {
  const workspace = new BrowserWorkspace(storage());
  workspace.write('test.bal', 'abc abc');
  assert.throws(() => workspace.edit('test.bal', 'abc', 'x'), /exactly once/);
  assert.throws(() => workspace.edit('test.bal', 'missing', 'x'), /exactly once/);
  assert.throws(() => workspace.edit('test.bal', '', 'x'), /exactly once/);
  assert.equal(workspace.read('test.bal'), 'abc abc');
  workspace.edit('test.bal', 'abc abc', '$&');
  assert.equal(workspace.read('test.bal'), '$&');
});

test('rejects paths outside the workspace and file/directory conflicts', () => {
  const workspace = new BrowserWorkspace(storage());
  for (const path of ['../test', '/etc/test', 'a/../b', 'a//b', 'a\\b', '']) {
    assert.throws(() => workspace.write(path, 'test'), /relative/);
  }
  workspace.write('a/b.bal', '');
  assert.throws(() => workspace.write('a', ''), /conflicts/);
  assert.throws(() => workspace.write('main.bal/nested', ''), /conflicts/);
  workspace.write('__proto__', 'safe');
  assert.equal(workspace.read('__proto__'), 'safe');
});

test('storage failure does not mutate files or publish a successful change', () => {
  let fail = false;
  const store = storage();
  const workspace = new BrowserWorkspace({ getItem: store.getItem, setItem: (key, value) => { if (fail) throw new Error('Quota exceeded'); store.setItem(key, value); } });
  fail = true;
  let updates = 0, storageUpdates = 0;
  workspace.subscribe(() => updates++);
  workspace.subscribeStorage(() => storageUpdates++);
  const before = workspace.snapshot(), saved = store.getItem(STORAGE_KEY), analysis = workspace.analysisSnapshot();
  assert.throws(() => workspace.write('main.bal', 'changed'), /Quota/);
  assert.equal(workspace.snapshot(), before);
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(workspace.analysisSnapshot(), analysis);
  assert.equal(updates, 0);
  assert.equal(storageUpdates, 1);
  assert.equal(workspace.storageSnapshot().writable, false);
  assert.match(workspace.storageSnapshot().error, /Quota/);
  assert.throws(() => workspace.write('main.bal', 'retry'), /read-only/);
});

test('invalid saved data is reported and left untouched', () => {
  const store = storage();
  store.setItem(STORAGE_KEY, 'broken json');
  const workspace = new BrowserWorkspace(store);
  assert.equal(workspace.storageSnapshot().writable, false);
  assert.match(workspace.storageSnapshot().error, /not been overwritten/);
  assert.throws(() => workspace.write('main.bal', 'changed'), /not been overwritten/);
  assert.equal(store.getItem(STORAGE_KEY), 'broken json');
});

test('initial storage access failures leave the workspace read-only', () => {
  for (const store of [
    { getItem() { throw Error('Storage denied'); }, setItem() { assert.fail('must not overwrite unreadable storage'); } },
    { getItem: () => null, setItem() { throw Error('Storage denied'); } },
  ]) {
    const workspace = new BrowserWorkspace(store);
    assert.equal(workspace.storageSnapshot().writable, false);
    assert.match(workspace.storageSnapshot().error, /Storage denied/);
    assert.throws(() => workspace.write('main.bal', 'changed'), /Storage denied/);
  }
});

test('invalid saved file maps are left untouched and valid empty workspaces stay empty', () => {
  for (const value of [null, [], { '../main.bal': '' }, { 'a': '', 'a/b': '' }, { 'main.bal': 42 }]) {
    const store = storage(), saved = JSON.stringify(value);
    store.setItem(STORAGE_KEY, saved);
    const workspace = new BrowserWorkspace(store);
    assert.equal(workspace.storageSnapshot().writable, false);
    assert.equal(store.getItem(STORAGE_KEY), saved);
  }
  const store = storage();
  store.setItem(STORAGE_KEY, '{}');
  const workspace = new BrowserWorkspace(store);
  assert.deepEqual(workspace.snapshot(), {});
  assert.deepEqual(workspace.storageSnapshot(), { writable: true });
});

test('file subscribers observe already-persisted snapshots; storage subscriptions can unsubscribe', () => {
  const store = storage(), workspace = new BrowserWorkspace(store);
  workspace.subscribe(() => assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)), workspace.snapshot()));
  workspace.write('notes.txt', 'local files are not extension-filtered');
  let updates = 0;
  const unsubscribe = workspace.subscribeStorage(() => updates++);
  unsubscribe();
  store.setItem = () => { throw Error('Quota exceeded'); };
  assert.throws(() => workspace.remove('notes.txt'), /Quota/);
  assert.equal(updates, 0);
});

test('subscribers see changes and can unsubscribe', () => {
  const workspace = new BrowserWorkspace(storage());
  let updates = 0;
  const unsubscribe = workspace.subscribe(() => updates++);
  workspace.write('test.bal', '');
  unsubscribe();
  workspace.remove('test.bal');
  assert.equal(updates, 1);
});

test('service discovery retains the anchor and its agent over shared workspace files', async () => {
  const workspace = new BrowserWorkspace(storage(), { compiler: {analyze}, streamFn() { throw new Error('No model request expected'); } });
  const [service] = await workspace.getServices();
  assert.equal((await workspace.getServices())[0], service);
  assert.equal(service.kind, 'http');
  assert.deepEqual(service.getEndpoints(), []);
  const [agent, sameAgent] = await Promise.all([service.getAgent(), service.getAgent()]);
  assert.equal(agent, sameAgent);
  agent.state.messages = [{ role: 'user', content: 'Retained conversation', timestamp: Date.now() }];
  assert.equal((await service.getAgent()).state.messages[0].content, 'Retained conversation');
  await agent.state.tools.find(tool => tool.name === 'write_file').execute('test', { path: 'shared.bal', content: '// shared' });
  assert.equal(workspace.read('shared.bal'), '// shared');
  await assert.rejects(service.getDiff(), /not implemented/);
  assert.deepEqual((await service.getFlowUI()).selection, {kind:'definitions',scopeId:service.id});
});

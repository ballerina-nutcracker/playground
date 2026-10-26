import { analyze, testAgentScope } from './fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceTools, createWorkspaceAgent } from '../src/index.ts';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createModels } from '@earendil-works/pi-ai';
import { BrowserWorkspace } from '../src/workspace.ts';
import { skillCatalogPrompt } from '../src/skills.ts';

test('PI tools edit the same persisted workspace that the UI observes', async () => {
  const stored = new Map();
  const store = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const workspace = new BrowserWorkspace(store);
  const tools = workspaceTools(workspace);
  const call = (name, args, signal) => tools.find(t => t.name === name).execute('test', args, signal);
  assert.match((await call('list_files', {})).content[0].text, /main.bal/);
  await call('write_file', { path: 'hello.bal', content: 'string hello = "hello";' });
  await call('edit_file', { path: 'hello.bal', oldText: '"hello"', newText: '"world"' });
  assert.equal((await call('read_file', { path: 'hello.bal' })).content[0].text, 'string hello = "world";');
  assert.equal(new BrowserWorkspace(store).read('hello.bal'), 'string hello = "world";');
  const aborted = AbortSignal.abort();
  await assert.rejects(call('write_file', { path: 'hello.bal', content: 'bad' }, aborted));
  assert.match(workspace.read('hello.bal'), /world/);
  await call('delete_file', { path: 'hello.bal' });
  await assert.rejects(call('read_file', { path: 'hello.bal' }), /not found/);
});

test('PI uses only workspace tools without browser credentials', () => {
  const workspace = new BrowserWorkspace({ getItem: () => null, setItem: () => {} });
  const models = createModels();
  models.setProvider(openaiProvider());
  const agent = createWorkspaceAgent(workspace, models.getModels('openai')[0], () => { throw new Error('No request expected'); }, testAgentScope);
  assert.equal(agent.getApiKey, undefined);
  assert.deepEqual(agent.state.tools.map(t => t.name), [...(skillCatalogPrompt() ? ['read_skill'] : []), 'get_diagnostics', 'list_files', 'read_file', 'write_file', 'edit_file', 'delete_file']);
  assert.match(agent.state.systemPrompt, /No shell or execution runtime/);
});

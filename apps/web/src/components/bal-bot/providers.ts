import { createModels, createAssistantMessageEventStream, type Model, type Api } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export const providerOptions = [
  { id: 'openai', name: 'OpenAI', description: 'OpenAI API key' },
  { id: 'anthropic', name: 'Anthropic', description: 'Anthropic API key' },
  { id: 'google', name: 'Gemini', description: 'Google Gemini API key' },
  { id: 'openrouter', name: 'OpenRouter', description: 'OpenRouter API key' },
];
export interface ProviderAccount { id: string; connected: boolean; models: Model<Api>[]; }

// Pi owns credential storage. Its default store is memory-only; never inject a
// persistent store or consult host environment credentials for this frontend.
export const models = createModels({ authContext: { async env() { return undefined; }, async fileExists() { return false; } } });
models.setProvider(openaiProvider());
models.setProvider(anthropicProvider());
models.setProvider(googleProvider());
const openrouter = openrouterProvider();
// Pi's bundled catalog still has only the free variant of M3.1 Flash.
// Keep its protocol settings, with the paid model's live OpenRouter limits/pricing.
const flash = openrouter.getModels().find(model => model.id === 'minimax/minimax-m3.1-flash:free');
const extraOpenRouterModels: Model<Api>[] = flash && !openrouter.getModels().some(model => model.id === 'minimax/minimax-m3.1-flash') ? [{
  ...flash,
  id: 'minimax/minimax-m3.1-flash',
  name: 'MiniMax: MiniMax M3.1 Flash',
  contextWindow: 1048576,
  maxTokens: 524288,
  cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
}] : [];
models.setProvider({
  ...openrouter,
  getModels: () => [...openrouter.getModels(), ...extraOpenRouterModels],
  getAllModels: () => [...(openrouter.getAllModels?.() ?? openrouter.getModels()), ...extraOpenRouterModels],
});
const selectedModels: Record<string, string[]> = {
  openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  google: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  openrouter: [
    'openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna',
    'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5',
    'google/gemini-4-argon', 'google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite',
    'recursive/flint-v1.0:free',
    'minimax/minimax-m3.1-flash',
    'deepseek/deepseek-v4.1-flash-1017',
    'reflection/beam-1.0-501b-a23b',
    'inception/mercury-3',
    'meta/muse-spark-open',
    'nvidia/nemotron-3.5-super-vl:free',
    'mistralai/mistral-large-4-0',
  ],
};
function requireProvider(id: string): void {
  if (!providerOptions.some(provider => provider.id === id)) throw new Error('Unknown provider');
}
export async function getAccounts(): Promise<ProviderAccount[]> {
  return Promise.all(providerOptions.map(async ({ id }) => {
    const available = models.getModels(id);
    const selected = selectedModels[id]?.flatMap(key => available.filter(model => model.id === key));
    return { id, connected: !!await models.checkAuth(id), models: selected ?? [...available] };
  }));
}
export async function loginProvider(id: string, key: string): Promise<void> {
  requireProvider(id);
  if (!key.trim()) throw new Error('Enter an API key.');
  await models.login(id, 'api_key', {
    signal: new AbortController().signal,
    async prompt(prompt) {
      if (prompt.type !== 'secret') throw new Error('Unexpected API key prompt.');
      return key.trim();
    },
    notify() {},
  });
}
export async function logoutProvider(id: string): Promise<void> {
  requireProvider(id);
  await models.logout(id);
}

export const streamBrowser: StreamFn = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    // Pi handles streaming, tool calls, auth resolution, and cancellation. Do not
    // forward raw provider errors, which may contain sensitive response bodies.
    for await (const event of models.streamSimple(model, context, { ...options, transport: 'sse' })) {
      stream.push(event.type === 'error' ? { ...event, error: { ...event.error,
        errorMessage: event.reason === 'aborted' ? 'Request stopped.' : 'The provider request failed before completion. Check your API key, quota, and browser connectivity (CORS), then retry.',
      } } : event);
    }
  })();
  return stream;
};

import { validateRequest, validateResponse, type CompilerRequest, type CompilerResponse, type CompilerBridge } from './protocol.ts';

// Module workers cannot use importScripts. Load the generated classic Go runtime
// as a module; it installs Go on globalThis and has no module exports.
const scope = globalThis as unknown as {
  Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void>; exit(code: number): void };
  balBotCompilerRequest?: (request: string) => string;
  balBotReady?: () => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(response: CompilerResponse): void;
};
let runtimeFailure: Error | undefined;
let rejectRuntime: (error: Error) => void;
const runtimeStopped = new Promise<never>((_, reject) => { rejectRuntime = reject; });
// Attach a handler immediately, including initialization failure paths.
void runtimeStopped.catch(() => {});

async function loadCompiler(): Promise<CompilerBridge> {
  const base = new URL(import.meta.env.BASE_URL + 'compiler/', self.location.origin);
  await import(/* @vite-ignore */ new URL('wasm_exec.js', base).href);
  const go = new scope.Go();
  let ready!: () => void;
  const bridgeReady = new Promise<void>(resolve => { ready = resolve; });
  scope.balBotReady = ready;
  const response = await fetch(new URL('ballerina-compiler.wasm', base));
  if (!response.ok) throw new Error(`Could not fetch compiler WASM (${response.status}).`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  const stopped = (reason: unknown) => {
    runtimeFailure = reason instanceof Error ? reason : new Error(String(reason));
    rejectRuntime(runtimeFailure);
  };
  go.exit = code => { stopped(new Error(`Go compiler runtime exited (${code}).`)); };
  void go.run(instance).then(() => stopped(new Error('Go compiler runtime terminated.')), stopped);
  let timeout!: ReturnType<typeof setTimeout>;
  const readinessTimeout = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Compiler bridge readiness timed out.')), 30000);
  });
  try { await Promise.race([bridgeReady, runtimeStopped, readinessTimeout]); }
  finally { clearTimeout(timeout); delete scope.balBotReady; }
  if (typeof scope.balBotCompilerRequest !== 'function') throw new Error('Compiler bridge did not initialize.');
  return { request(json) {
    if (runtimeFailure) throw runtimeFailure;
    const result = scope.balBotCompilerRequest!(json);
    if (runtimeFailure) throw runtimeFailure;
    return result;
  } };
}
async function handleRequest(request: CompilerRequest): Promise<CompilerResponse> {
  try {
    const bridge = await loadCompiler();
    const result = validateResponse(JSON.parse(bridge.request(JSON.stringify(request))));
    // Flush Go's completion promise before reporting successful diagnostics.
    await Promise.race([Promise.resolve(), runtimeStopped]);
    if (runtimeFailure) throw runtimeFailure;
    return result;
  } catch (error) { return { kind: 'failure', message: error instanceof Error ? error.message : String(error) }; }
}
scope.onmessage = async event => {
  scope.onmessage = null;
  try { scope.postMessage(await handleRequest(validateRequest(event.data))); }
  catch (error) { scope.postMessage({ kind: 'failure', message: String(error) }); }
};

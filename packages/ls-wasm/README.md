# Language server WASM

This package hosts the **real Go language server** in a persistent JS/WASM session, separate from program execution. It constructs `event.New()`, `workspace.New(platform, bus)`, `compile.New(projects, bus)`, then `server.New(transport, projects, compiler, bus)`. The compiler worker pool is limited to one worker in the single-threaded WASM runtime.

## Build and test

From the repository root:

```sh
bun run --filter @playground/ls-wasm build
bun run --filter @playground/ls-wasm test
```

The build fetches `https://github.com/ballerina-nutcracker/ballerina.git` at **`e64ff12f6e1e947ed7a473363507f34bf16a6eb0`** (`main`) into the ignored `.upstream/` build cache. Module replacements are relative to that cache; neither the sibling developer checkout nor machine-specific paths are used. Go **1.27.1** is selected explicitly (Go may download this toolchain). Dependencies are recorded in `go.mod` and `go.sum`.

The pinned revision is built unmodified. Preparation fails if the cache has local changes. Remove `.upstream/` to recreate the cache. No sibling source is modified.

### Use a local language-server checkout

To select a local checkout persistently on this machine (build and test):

```sh
printf '%s\n' /absolute/path/to/ballerina > packages/ls-wasm/.source-dir
bun run --filter @playground/ls-wasm build
bun run --filter @playground/web copy:ls-wasm
```

Alternatively, set `LS_SOURCE_DIR` for a single invocation. Local builds use all
compiler modules from that checkout, including uncommitted changes, without
modifying the checkout.
The source selection and generated `.local.go.mod`/`.local.go.sum` are ignored by
Git. Remove `.source-dir` and unset `LS_SOURCE_DIR` to return to the pinned source.
LS builds bypass Turbo's cache so edits outside this repository are rebuilt.

Outputs:

- `dist/ballerina-ls.wasm`
- `dist/wasm_exec.js`, copied from **the same Go toolchain** that built the artifact

The prototype's language-analysis/compiler revision differs from `packages/wasm`'s program runner. Align revisions before release. The artifact is approximately 33 MiB uncompressed. Tests include native race-enabled filesystem/framing tests, the upstream compiler/server native race-enabled suites, the filesystem/framing tests under JS/WASM, and a Node smoke test of the shipped artifact covering readiness, initialization capabilities, per-file/versioned diagnostics, Unicode positions, unsaved completion, full/ranged changes, rapid unique-labelled revisions, close-clear ordering, and shutdown. A second artifact smoke test verifies standalone and package Hello World with `ballerina/io`, genuine undefined io-call arguments and correction, and a real `http:Listener` service.

## JavaScript worker interface

Load `dist/wasm_exec.js` **only in the dedicated language-server worker**, instantiate the WASM with `new Go().importObject`, and call `go.run(instance)` without awaiting it: Go remains alive for the worker's lifetime.

After all APIs are registered, Go sets `globalThis.languageServerReady = true` and invokes `globalThis.onLanguageServerReady()` if that function was installed before `go.run`. Workers can await that callback or inspect the flag before completing their own initialization. Readiness means API registration, not LSP initialization.

```ts
type LanguageServerFile = {
  path: string;
  content?: string;
  isDir: boolean;
};

declare function startLanguageServer(
  onMessage: (json: string) => void,
): Promise<void>;
declare function sendLanguageServerMessage(message: string): Promise<void>;
declare function updateLanguageServerFiles(
  entries: LanguageServerFile[],
): Promise<void>;
```

- **`startLanguageServer`** constructs one persistent server session. Call exactly once per worker. Its callback receives each unframed JSON response/notification, including asynchronous diagnostics. Restart by terminating/recreating the worker; normal LSP `shutdown`/`exit` ends the server session.
- **`sendLanguageServerMessage`** enqueues an unframed JSON object in call order. Resolution means **queued**, not processed; correlate request responses using LSP IDs. Go adds `Content-Length` using UTF-8 byte length. Server output framing is stripped without JSON re-encoding. Messages larger than 16 MiB are rejected. Calls before start or after session exit reject.
- **`updateLanguageServerFiles`** atomically replaces the complete saved-file snapshot. Omitted files are deleted. This can be called before or after start. Paths may be browser-relative (`examples/main.bal`) or already canonical (`/workspace/examples/main.bal`). Both become `/workspace/examples/main.bal`; reject parent traversal, backslashes, and absolute paths outside `/workspace`. Pass paths, **not URIs**. Files without `content` are empty. Explicit directory entries are accepted, and missing parent directories are synthesized. Conflicting/duplicate entries reject without changing the previous snapshot.
- All functions return `Promise<void>` and reject on invalid arguments. The snapshots are read-only through PAL; no native filesystem or JS filesystem callback is used. PAL `Stat`, `ReadFile`, `ReadDir`, and streaming reads observe immutable nodes; directory listings are sorted.

Before `didOpen`, copy the entire workspace (including `Ballerina.toml`, modules, and directory entries). Use percent-encoded `file:///workspace/...` URIs consistently in all LSP messages. Unsaved changes belong in versioned `textDocument/didChange`, not the saved snapshot. For saved changes, creation, or deletion, **await the snapshot replacement before sending `workspace/didChangeWatchedFiles`**. Updating the snapshot alone does not notify the server or overwrite an open document's LSP overlay.

The upstream dispatcher currently advertises incremental text synchronization, completion and signature help (core function, method, remote-method and `new` calls; triggers `(` and `,`), not hover/navigation/rename/formatting. This package does not manufacture capabilities or diagnostics. Embedded standard libraries (including `ballerina/io` and `ballerina/http`) and language libraries resolve through the real upstream repository/resolver. Arbitrary external dependency/bala repositories are not injected into the browser environment; imports outside the embedded bundles still require future repository support. The pinned upstream package graph does not yet invalidate on unsaved import-declaration changes; saved filesystem changes plus watched-file notifications reload projects. `Ballerina.toml` and sibling modules are read through PAL. Diagnostic severity and recovery behavior also come directly from upstream.

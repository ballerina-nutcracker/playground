export type Files = Readonly<Record<string, string>>;
export type FileChange = { kind: 'write'; path: string; content: string } | { kind: 'delete'; path: string };

export const initialFiles: Files = {
  'Ballerina.toml': '[package]\norg = "browser"\nname = "http_service"\nversion = "0.1.0"\n',
  'main.bal': 'import ballerina/http;\n\nservice / on new http:Listener(8080) {\n    resource function get hello() returns string {\n        return "Hello, World!";\n    }\n}\n',
};

export function validatePath(path: string): string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f]/.test(path)) {
    throw new Error('Use a relative workspace file path without empty, . or .. segments.');
  }
  return path;
}
export function validateChange(value: unknown): asserts value is FileChange {
  const change = value as FileChange;
  if (!change || (change.kind !== 'write' && change.kind !== 'delete')) throw new Error('Invalid file change.');
  validatePath(change.path);
  if (change.kind === 'write' && (typeof change.content !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(change.content))) throw new Error('File contents must be valid UTF-8 text.');
}
export function validateFiles(value: unknown): asserts value is Files {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace files.');
  for (const [path, content] of Object.entries(value)) {
    validatePath(path);
    if (typeof content !== 'string') throw new Error('Invalid file contents.');
    validateChange({ kind: 'write', path, content });
    if (path.split('/').slice(0, -1).some((_, i, parts) => Object.hasOwn(value, parts.slice(0, i + 1).join('/')))) throw new Error('A file conflicts with this directory path.');
  }
}
export function applyChange(files: Files, change: FileChange): Files {
  if (change.kind === 'write') return { ...files, [change.path]: change.content };
  const next = { ...files };
  delete next[change.path];
  return next;
}

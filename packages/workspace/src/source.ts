import type { Files, SourceRange } from './index.ts';
import type { SourceReference } from './flow.ts';

// Resolve code-point columns against the captured text, treating CRLF as one break.
export function sourceText(files: Files, reference: SourceReference): string {
  const text = files[reference.file];
  if (text === undefined) throw new Error(`Source file is unavailable: ${reference.file}`);
  const offset = (position: SourceRange['start']) => {
    if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) || position.line < 1 || position.column < 1) throw new Error('Invalid source position.');
    let line = 1, column = 1, i = 0;
    for (; i < text.length; ) {
      if (line === position.line && column === position.column) return i;
      const point = text.codePointAt(i)!;
      if (point === 13) { i += text[i + 1] === '\n' ? 2 : 1; line++; column = 1; }
      else if (point === 10) { i++; line++; column = 1; }
      else { i += point > 0xffff ? 2 : 1; column++; }
    }
    if (line === position.line && column === position.column) return i;
    throw new Error(`Source range is out of bounds: ${reference.file}`);
  };
  const start = offset(reference.range.start), end = offset(reference.range.end);
  if (end < start) throw new Error('Reversed source range.');
  return text.slice(start, end);
}

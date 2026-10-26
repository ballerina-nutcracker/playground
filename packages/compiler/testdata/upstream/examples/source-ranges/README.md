# Unicode and newline source ranges

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Select the multiline decorate call: include all occupied rows and the exact text. Verify code-point columns after the astral character, Unicode text, and cross-file windowsValue expansion. windows.bal deliberately uses actual CRLF. For normalization-only exclusive-end-at-column-one checks, use the same captured source with a synthetic boundary at the next row's column 1; the displayed inclusive end row is the preceding row. Do not require the parser to emit that boundary itself.

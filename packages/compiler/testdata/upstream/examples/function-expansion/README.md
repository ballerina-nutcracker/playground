# Inline calls and recursion

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Expand each shared call independently; both bodies refer to helpers.bal, while headers refer to their separate caller ranges. Expand countdown and evenStep/oddStep until recursive ancestry is reached. Stop expansion there with an explanation. Returns rejoin the correct call continuation, not main's exit. Preserve expansion choices when resizing the panel.

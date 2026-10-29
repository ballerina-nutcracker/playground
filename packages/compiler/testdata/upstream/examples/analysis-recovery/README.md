# Invalid edits and analysis races

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

1. Load the valid baseline and select/expand double.
2. Replace `int amount = 2;` with `int amount = true + 2;`, save, and check that the old flow is marked stale with diagnostics and new chip insertion disabled.
3. Repair it; the current flow becomes usable.
4. Remove main's closing brace, save, and verify stale behavior for syntax errors; restore it.
5. In a browser harness, delay analysis A, save amount=3 to launch B, and complete A last. Only B may publish. Also edit back to amount=2 while A is pending; the old revision is still obsolete.
6. Simulate worker failure then retry. Preserve previous flow, show the infrastructure error, and recover without reloading.

The type-error edit uses an invalid operator expression diagnosed during local type resolution. Flow analysis stops before semantic analysis; it does not replace full checking of assignments, arguments, returns, or other later diagnostics through get_diagnostics.

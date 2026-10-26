# Visible limitations without false flow

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

The record initializer remains a collapsed amber source mapping. Match, check, and start/wait are source-backed unsupported regions with explanations, without fabricated ordinary sequential execution through unknown effects. The conditional positive call must not be expanded into unconditional execution. Later source remains visible even when continuation is unknown. Dedicated mapping internals and dotted async dependencies are deferred. The browser must not execute this program.

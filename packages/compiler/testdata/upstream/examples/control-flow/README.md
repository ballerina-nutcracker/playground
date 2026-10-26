# Branches, loops, and abrupt exits

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Expand process. Verify nearest-loop break/continue routing, while back edge, foreach container without routine back arrow, else-if and empty branch continuation. The early return does not join the continuing branches. final return has no outgoing function-internal edge. Every node selects its own source range.

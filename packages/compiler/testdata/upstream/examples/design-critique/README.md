# Representative browser design comparison

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Two independent critique subagents inspect the live browser against docs/ui/images/workspace.svg, endpoint-normal.svg, endpoint-expanded.svg, and endpoint-flow.svg. Review separately: service definition list; normal layout; expanded layout and floating chat; branch/loop geometry; calculate expansion; chip and stale interactions. Use definitions-and-calls for the complete connector list and panel-state for overflow. Compare behavior and visual hierarchy, not the literal sample labels. No zoom/diff/green highlights, mapping expansion, or async diagram is expected. For each item fix/reinspect for at most five rounds, stopping when both agree; report unresolved disagreements at the limit. No browser critique has been performed merely by adding this package.

## Supported compiler scope

minimum is an ordinary final module variable used by the loop condition. This fixture contains no configurable declarations and requires no compiler adaptation. Configurables are outside this iteration's browser critique scope.

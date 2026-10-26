# Definitions and resolved call targets

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

At service level list calculate and unusedHelper, Order and UnusedRecord, upstreamClient under Connectors. Expand calculate to helpers.bal and math:calculate to modules/math/calculate.bal: identical names must not confuse target resolution. LocalClient is a client type used to verify connector classification without error-handling syntax in its initializer. The client initializer is source data; never execute it during inspection.

minimumAmount and upstream are ordinary final module variables, not configurables. unusedHelper reads upstream and invokes upstreamClient so these module variables satisfy the pinned compiler's usage rules. The helper itself has no callers, and UnusedRecord remains unreferenced; both must still appear in service inspection. This fixture tests unreferenced functions/types without requiring unused module variables.

## Supported compiler scope

This fixture uses only features accepted by the pinned Nutcracker compiler. Configurable declarations are excluded. All module variables are referenced; unusedHelper and UnusedRecord still test discovery of unreferenced functions and types.

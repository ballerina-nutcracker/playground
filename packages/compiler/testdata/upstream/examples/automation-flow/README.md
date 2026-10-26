# Automation entry point

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

There are no services. Navigation shows Automation. Its flow starts with main's count declaration, contains a while condition/body/back edge/exit, then finish. Select a node to attach a source reference. Agent guidance identifies main and this package, without assuming an HTTP service.

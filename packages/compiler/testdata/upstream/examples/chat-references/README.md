# Source references in chat drafts

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Use mocked provider transport. Type prose, select a node, select it again, and remove its chip: prose is unchanged and duplicates are not added. Expand shared; its body chip references the definition while its header references the caller. Switch endpoint conversations and return: each draft/chip list is retained. Selection never sends. Submit explicitly and inspect the serialized source/path/range. Allow a chips-only submission. Save an edit after selection and ensure stale chips block sending until removed/reselected, including a saved-file event immediately before send.

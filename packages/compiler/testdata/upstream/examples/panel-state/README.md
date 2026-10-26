# Panel expansion and conversation state

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

At normal width verify 20/60/20 proportions. Expand buildReport and type a draft with a chip. Expand inspection to the area below the top bar; navigation/chat columns give way to the canvas and floating chat. Drag chat by its header, resize the viewport, then collapse. Conversation, draft, selected endpoint, and expansions survive. Switch endpoints and back. Long labels wrap; the graph scales down to fit the panel width with side margins and retains vertical scrolling. Resize and call expansion update the fit without manual zoom. Normal mode retains file navigation and editing.

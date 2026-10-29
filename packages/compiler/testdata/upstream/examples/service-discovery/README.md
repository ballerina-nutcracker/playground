# Service and endpoint discovery

Use this package as a reference fixture in the [browser-only workspace](../README.md). Start with `npm run dev`; local package directories cannot be opened or synchronized.

This package is input for the flow feature specified in [spec.md](../../spec.md). The current editor may not yet provide these interactions. Source inspection and compilation must not run the program or start a listener.

## Scenario and expected result

Select all three services. Orders has GET /orders/orders and remote refresh endpoints; formatOrder is a function, not an endpoint. Inventory has GET /inventory/items. All inspection lists include sharedLabel and unusedHelper. The datagram service in datagrams.bal uses udp:Listener and exposes remote onBytes; its type label must come from UDP rather than the HTTP default. Neither service is discovered from the filename. Ordinary methods belong only to their own service's Functions list.

# Client calls and error operators

Select `GET /hello` to inspect the HTTP client constructor, the original call arguments, the explicit `Return error` path, and the return string template. The flow does not combine constructor arguments and call arguments into a guessed URL.

`sendMessage` uses the same card for a workspace client with named constructor and method arguments. `capturePanic` exercises nested `trap` and `checkpanic` expressions. Long client initializers can be expanded; parameters and mutable receivers retain conservative origin labels rather than displaying an unreliable constructor.

//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/ballerina-nutcracker/ballerina/ls/core/compile"
	"github.com/ballerina-nutcracker/ballerina/ls/core/event"
	"github.com/ballerina-nutcracker/ballerina/ls/server"
)

var registeredFunctions []js.Func

// Callbacks perform only bounded synchronous work and return already settled
// promises. send's promise means queued, not that the request was processed.
func promiseResult(err error) js.Value {
	promise := js.Global().Get("Promise")
	if err != nil {
		return promise.Call("reject", js.Global().Get("Error").New(err.Error()))
	}
	return promise.Call("resolve")
}

func invokeCallback(callback func([]js.Value) error, args []js.Value) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("language server API: %v", recovered)
		}
	}()
	return callback(args)
}

func register(name string, callback func([]js.Value) error) {
	fn := js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promiseResult(invokeCallback(callback, args))
	})
	registeredFunctions = append(registeredFunctions, fn)
	js.Global().Set(name, fn)
}

func main() {
	files := newMemoryFS()
	var transport *serverTransport
	started := false

	register("updateLanguageServerFiles", func(args []js.Value) error {
		if len(args) != 1 || !js.Global().Get("Array").Call("isArray", args[0]).Bool() {
			return fmt.Errorf("updateLanguageServerFiles expects an array of file entries")
		}
		payload := js.Global().Get("JSON").Call("stringify", args[0])
		var entries []fileEntry
		if err := json.Unmarshal([]byte(payload.String()), &entries); err != nil {
			return fmt.Errorf("invalid workspace file entries: %w", err)
		}
		return files.replace(entries)
	})
	register("startLanguageServer", func(args []js.Value) error {
		if started {
			return fmt.Errorf("language server session already started; create a new worker to restart")
		}
		if len(args) != 1 || args[0].Type() != js.TypeFunction {
			return fmt.Errorf("startLanguageServer expects an onMessage callback")
		}
		onMessage := args[0]
		transport = &serverTransport{
			messageQueue: newMessageQueue(),
			output: frameDecoder{onJSON: func(message string) {
				// A consumer exception must not kill the Go runtime or the session.
				defer func() {
					if err := recover(); err != nil {
						js.Global().Get("console").Call("error", fmt.Sprint("language server onMessage: ", err))
					}
				}()
				onMessage.Invoke(message)
			}},
		}
		bus := event.New()
		projects := newProjectService(files, bus)
		compiler := compile.New(projects, bus, compile.WithMaxWorkers(1))
		ls := server.New(transport, projects, compiler, bus)
		started = true
		go func() {
			defer bus.Close()
			defer compiler.Shutdown()
			defer transport.close()
			if err := ls.Serve(); err != nil {
				js.Global().Get("console").Call("error", "language server stopped: "+err.Error())
			}
		}()
		return nil
	})
	register("sendLanguageServerMessage", func(args []js.Value) error {
		if !started {
			return fmt.Errorf("startLanguageServer must be called before sending messages")
		}
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return fmt.Errorf("sendLanguageServerMessage expects unframed JSON text")
		}
		return transport.enqueue(args[0].String())
	})

	// Register every API before signalling readiness. go.run remains pending
	// for the lifetime of the worker, so consumers must not await it to init.
	js.Global().Set("languageServerReady", true)
	if ready := js.Global().Get("onLanguageServerReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}

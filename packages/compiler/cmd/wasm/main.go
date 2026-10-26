//go:build js && wasm

package main

import (
	"balbot/compiler"
	"encoding/json"
	"fmt"
	"syscall/js"
)

func requestJSON(request string) (response string) {
	failure := func(err any) string {
		data, _ := json.Marshal(map[string]any{"kind": "failure", "message": fmt.Sprint(err)})
		return string(data)
	}
	defer func() {
		if p := recover(); p != nil {
			response = failure(fmt.Sprintf("compiler panic: %v", p))
		}
	}()
	var input struct {
		Operation string         `json:"operation"`
		Files     compiler.Files `json:"files"`
	}
	if err := json.Unmarshal([]byte(request), &input); err != nil {
		return failure(err)
	}
	var result any
	var err error
	switch input.Operation {
	case "check":
		result, err = compiler.Check(input.Files)
	case "analyze":
		result, err = compiler.Analyze(input.Files)
	default:
		return failure("Invalid compiler operation")
	}
	if err != nil {
		return failure(err)
	}
	data, err := json.Marshal(map[string]any{"kind": "result", "operation": input.Operation, "result": result})
	if err != nil {
		return failure(err)
	}
	return string(data)
}
func main() {
	callback := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return `{"kind":"failure","message":"Invalid bridge request"}`
		}
		return requestJSON(args[0].String())
	})
	defer callback.Release()
	js.Global().Set("balBotCompilerRequest", callback)
	js.Global().Call("balBotReady")
	select {}
}

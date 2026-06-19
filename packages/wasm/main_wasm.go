// Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package main

import (
	_ "ballerina-lang-go/lib/rt"
	"ballerina-lang-go/platform/pal"
	"ballerina-lang-go/projects"
	"ballerina-lang-go/runtime"
	"ballerina-lang-go/tools/diagnostics"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))
	js.Global().Set("getDiagnostics", js.FuncOf(getDiagnostics))
	js.Global().Set("dispatchHttp", js.FuncOf(dispatchHttp))
	js.Global().Set("stopService", js.FuncOf(stopService))

	select {}
}

// activeService holds the runtime and controller for the currently-running
// service program (if any), so dispatchHttp can route injected requests and
// stopService can wind it down. A plain main program leaves these nil.
var (
	activeMu   sync.Mutex
	activeRT   *runtime.Runtime
	activeCtrl *wasmController
)

func setActiveService(rt *runtime.Runtime, ctrl *wasmController) {
	activeMu.Lock()
	defer activeMu.Unlock()
	activeRT, activeCtrl = rt, ctrl
}

func getActiveService() (*runtime.Runtime, *wasmController) {
	activeMu.Lock()
	defer activeMu.Unlock()
	return activeRT, activeCtrl
}

// stopActiveService gracefully stops the running service (if any) and blocks
// until it has fully wound down. Called before a new run and from stopService.
func stopActiveService() {
	activeMu.Lock()
	rt, ctrl := activeRT, activeCtrl
	activeRT, activeCtrl = nil, nil
	activeMu.Unlock()
	if rt == nil || ctrl == nil {
		return
	}
	select {
	case ctrl.signals <- pal.GracefulStop:
	default:
	}
	<-rt.ExitStatus
	close(ctrl.signals)
}

func runOutcome(stdout, stderr string) map[string]any {
	return map[string]any{
		"stdout": stdout,
		"stderr": stderr,
	}
}

func run(_ js.Value, args []js.Value) any {
	return newPromise(func(resolve js.Value, _ js.Value) {
		go func() {
			onOutput := js.Null()
			if len(args) >= 3 {
				onOutput = args[2]
			}

			stderr := outputWriter{onOutput: onOutput, stream: "stderr"}
			stdout := outputWriter{onOutput: onOutput, stream: "stdout"}
			runResult := map[string]any{"service": false}
			done := func() { resolve.Invoke(js.ValueOf(runResult)) }

			defer func() {
				if r := recover(); r != nil {
					fmt.Fprintf(stderr, "%v\n", r)
				}
				done()
			}()

			if len(args) < 2 {
				fmt.Fprintf(stderr, "expected at least 2 arguments: (fsProxy, path[, onOutput])\n")
				return
			}

			proxy := args[0]
			path := args[1].String()
			fsys := NewBridgeFS(proxy)

			result, err := projects.Load(fsys, path)
			if err != nil {
				fmt.Fprintf(stderr, "%v\n", err)
				return
			}

			if diags := result.Diagnostics(); diags.HasErrors() {
				printDiagnostics(fsys, path, stderr, diags, diagnostics.NewDiagnosticEnv())
				return
			}

			compilation := result.Project().CurrentPackage().Compilation()
			if diags := compilation.DiagnosticResult(); diags.HasErrors() {
				printDiagnostics(fsys, path, stderr, diags, compilation.DiagnosticEnv())
				return
			}

			project := result.Project()

			birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
			if len(birPkgs) == 0 {
				fmt.Fprintf(stderr, "BIR generation failed: no BIR package produced\n")
				return
			}

			// Wind down a service left running by a previous run before starting a new one.
			stopActiveService()

			platform, ctrl := wasmPal(stderr, stdout, fsys)
			rt := runtime.NewRuntime(platform, project.Environment().TypeEnv())

			var initErr error
			for _, birPkg := range birPkgs {
				if err := rt.Init(*birPkg); err != nil {
					fmt.Fprintf(stderr, "%v\n", err)
					initErr = err
					break
				}
			}
			rt.Listen()
			if initErr != nil {
				return
			}

			// A service program stays in the listening state after Listen, ready to
			// receive injected requests; a plain main program has already run and
			// stopped. Distinguish with a non-blocking read of ExitStatus.
			select {
			case <-rt.ExitStatus:
				// main program finished — nothing to keep alive.
			default:
				setActiveService(rt, ctrl)
				runResult = map[string]any{
					"service": true,
					"addrs":   toAnySlice(ctrl.registry.addrs()),
				}
			}
		}()
	})
}

// dispatchHttp injects a request into the running service and resolves with its
// response. JS request shape: { method, host, port, path, query, headers, body }.
func dispatchHttp(_ js.Value, args []js.Value) any {
	return newPromise(func(resolve, reject js.Value) {
		if len(args) < 1 || args[0].Type() != js.TypeObject {
			reject.Invoke(jsError("dispatchHttp: expected a request object"))
			return
		}
		spec := args[0]

		_, ctrl := getActiveService()
		if ctrl == nil {
			reject.Invoke(jsError("no running service to dispatch to"))
			return
		}

		key := fmt.Sprintf("%s:%s", stringField(spec, "host", "localhost"), stringField(spec, "port", "0"))
		handler, ok := ctrl.registry.handlerFor(key)
		if !ok {
			reject.Invoke(jsError(fmt.Sprintf("no service listening on %s (active: %v)", key, ctrl.registry.addrs())))
			return
		}

		req, err := buildDispatchRequest(spec, key)
		if err != nil {
			reject.Invoke(jsError(err.Error()))
			return
		}

		rec := httptest.NewRecorder()
		func() {
			defer func() {
				if r := recover(); r != nil {
					http.Error(rec, fmt.Sprintf("%v", r), http.StatusInternalServerError)
				}
			}()
			handler.ServeHTTP(rec, req)
		}()

		resolve.Invoke(dispatchResponse(rec))
	})
}

// stopService gracefully stops the running service, if any.
func stopService(_ js.Value, _ []js.Value) any {
	return newPromise(func(resolve, _ js.Value) {
		stopActiveService()
		resolve.Invoke(js.Undefined())
	})
}

// buildDispatchRequest assembles an *http.Request from the JS request spec.
func buildDispatchRequest(spec js.Value, hostPort string) (*http.Request, error) {
	method := strings.ToUpper(stringField(spec, "method", "GET"))
	path := stringField(spec, "path", "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := "http://" + hostPort + path
	if query := stringField(spec, "query", ""); query != "" {
		url += "?" + strings.TrimPrefix(query, "?")
	}

	var body io.Reader
	if b := stringField(spec, "body", ""); b != "" {
		body = strings.NewReader(b)
	}

	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}
	for name, vals := range parseHeaders(spec.Get("headers")) {
		for i, v := range vals {
			if i == 0 {
				req.Header.Set(name, v)
			} else {
				req.Header.Add(name, v)
			}
		}
	}
	return req, nil
}

// dispatchResponse converts the recorded response into a JS object.
func dispatchResponse(rec *httptest.ResponseRecorder) js.Value {
	res := rec.Result()
	headers := map[string]any{}
	for name, vals := range res.Header {
		headers[name] = toAnySlice(vals)
	}
	return js.ValueOf(map[string]any{
		"status":  rec.Code,
		"headers": headers,
		"body":    rec.Body.String(),
	})
}

// parseHeaders reads a JS headers object whose values are strings or arrays of strings.
func parseHeaders(v js.Value) map[string][]string {
	out := map[string][]string{}
	if v.Type() != js.TypeObject {
		return out
	}
	keys := js.Global().Get("Object").Call("keys", v)
	for i := 0; i < keys.Length(); i++ {
		name := keys.Index(i).String()
		val := v.Get(name)
		switch {
		case val.Type() == js.TypeString:
			out[name] = []string{val.String()}
		case val.InstanceOf(js.Global().Get("Array")):
			for j := 0; j < val.Length(); j++ {
				out[name] = append(out[name], val.Index(j).String())
			}
		}
	}
	return out
}

func stringField(v js.Value, name, fallback string) string {
	f := v.Get(name)
	switch f.Type() {
	case js.TypeString:
		return f.String()
	case js.TypeNumber:
		// js.Value.String() yields "<number: N>" for numbers; format the digits.
		return strconv.FormatFloat(f.Float(), 'f', -1, 64)
	default:
		return fallback
	}
}

func toAnySlice(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

func jsError(msg string) js.Value {
	return js.Global().Get("Error").New(msg)
}

func getDiagnostics(_ js.Value, args []js.Value) any {
	return newPromise(func(resolve js.Value, reject js.Value) {
		defer func() {
			if r := recover(); r != nil {
				resolve.Invoke(js.ValueOf([]any{}))
			}
		}()

		if len(args) < 2 {
			resolve.Invoke(js.ValueOf([]any{}))
			return
		}

		proxy := args[0]
		path := args[1].String()
		fsys := NewBridgeFS(proxy)

		result, err := projects.Load(fsys, path)
		if err != nil {
			resolve.Invoke(js.ValueOf([]any{}))
			return
		}

		if result.Diagnostics().HasErrors() {
			resolve.Invoke(mapDiagnostics(result.Diagnostics().Diagnostics(), diagnostics.NewDiagnosticEnv()))
			return
		}

		compilation := result.Project().CurrentPackage().Compilation()
		if compilation.DiagnosticResult().HasErrors() {
			resolve.Invoke(mapDiagnostics(compilation.DiagnosticResult().Diagnostics(), compilation.DiagnosticEnv()))
			return
		}

		resolve.Invoke(js.ValueOf([]any{}))
	})
}

type outputWriter struct {
	onOutput js.Value
	stream   string
}

func (w outputWriter) Write(p []byte) (int, error) {
	emitOutput(w.onOutput, w.stream, string(p))
	return len(p), nil
}

func emitOutput(onOutput js.Value, stream, text string) {
	if onOutput.Type() != js.TypeFunction {
		return
	}
	onOutput.Invoke(map[string]any{
		"stream": stream,
		"text":   text,
	})
}

func mapDiagnostics(diags []diagnostics.Diagnostic, de *diagnostics.DiagnosticEnv) []any {
	mapped := make([]any, 0, len(diags))
	for _, d := range diags {
		location := d.Location()
		if diagnostics.IsLocationEmpty(location) || !diagnostics.LocationHasSource(location) {
			continue
		}

		start := map[string]any{"line": de.StartLine(location), "character": de.StartColumn(location)}
		end := map[string]any{"line": de.EndLine(location), "character": de.EndColumn(location)}
		mapped = append(mapped, map[string]any{
			"range": map[string]any{
				"start": start,
				"end":   end,
			},
			"severity": 1,
			"message":  d.Message(),
		})
	}
	return mapped
}

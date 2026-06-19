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
	"ballerina-lang-go/platform/pal"
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"syscall/js"
	"time"
)

var processStart = time.Now()

// ---------------------------------------------------------------------------
// Outbound HTTP client (browser fetch).
// ---------------------------------------------------------------------------

type fetchHTTPClient struct {
	cfg pal.ClientConfig
}

type requestContext struct {
	controller js.Value
	timeout    *time.Timer
}

func (ctx *requestContext) cleanup() {
	if ctx.timeout != nil {
		ctx.timeout.Stop()
	}
}

// Execute implements pal.HTTPClient. The body is buffered eagerly (browser fetch
// has no streaming-upload story we rely on) and the response is returned as an
// in-memory io.ReadCloser. ctx is accepted for interface conformance; per-request
// cancellation in the browser is driven by the AbortController timeout below.
func (c *fetchHTTPClient) Execute(_ context.Context, method, url string, body io.Reader, _ int64, contentType string, reqHeaders map[string][]string) (int, map[string][]string, io.ReadCloser, error) {
	fetch := js.Global().Get("fetch")
	if !fetch.Truthy() {
		return 0, nil, nil, fmt.Errorf("browser fetch API is not available")
	}

	var bodyBytes []byte
	if body != nil {
		b, err := io.ReadAll(body)
		if err != nil {
			return 0, nil, nil, err
		}
		bodyBytes = b
	}

	reqCtx := &requestContext{}
	defer reqCtx.cleanup()

	options := c.buildFetchOptions(method, bodyBytes, contentType, reqHeaders, reqCtx)

	resp, err := c.executeRequest(fetch, url, options)
	if err != nil {
		return 0, nil, nil, err
	}

	respHeaders := c.extractHeaders(resp)
	respBody, err := c.extractBody(resp)
	if err != nil {
		return 0, nil, nil, err
	}

	return resp.Get("status").Int(), respHeaders, io.NopCloser(bytes.NewReader(respBody)), nil
}

func (c *fetchHTTPClient) buildFetchOptions(method string, body []byte, contentType string, reqHeaders map[string][]string, reqCtx *requestContext) map[string]any {
	options := map[string]any{
		"method":   method,
		"headers":  c.buildHeaders(contentType, reqHeaders),
		"redirect": redirectMode(c.cfg.FollowRedirects.Enabled),
	}

	if body != nil && methodAllowsBody(method) {
		options["body"] = c.encodeBody(body)
	}
	if c.cfg.Timeout > 0 {
		options["signal"] = c.setupTimeout(reqCtx)
	}

	return options
}

func methodAllowsBody(method string) bool {
	switch strings.ToUpper(method) {
	case "GET", "HEAD":
		return false
	default:
		return true
	}
}

func (c *fetchHTTPClient) buildHeaders(contentType string, reqHeaders map[string][]string) js.Value {
	headers := js.Global().Get("Headers").New()

	for k, vals := range reqHeaders {
		if len(vals) == 0 {
			continue
		}
		headers.Call("set", k, vals[0])
		for _, v := range vals[1:] {
			headers.Call("append", k, v)
		}
	}

	if contentType != "" {
		headers.Call("set", "Content-Type", contentType)
	}

	return headers
}

func (c *fetchHTTPClient) encodeBody(body []byte) js.Value {
	bodyBytes := js.Global().Get("Uint8Array").New(len(body))
	js.CopyBytesToJS(bodyBytes, body)
	return bodyBytes
}

func (c *fetchHTTPClient) setupTimeout(reqCtx *requestContext) js.Value {
	reqCtx.controller = js.Global().Get("AbortController").New()
	reqCtx.timeout = time.AfterFunc(c.cfg.Timeout, func() {
		reqCtx.controller.Call("abort")
	})
	return reqCtx.controller.Get("signal")
}

func (c *fetchHTTPClient) executeRequest(fetch js.Value, url string, options map[string]any) (js.Value, error) {
	resp, err := awaitPromise(fetch.Invoke(url, js.ValueOf(options)))
	return resp, err
}

func (c *fetchHTTPClient) extractHeaders(resp js.Value) map[string][]string {
	respHeaders := map[string][]string{}
	forEach := js.FuncOf(func(_ js.Value, args []js.Value) any {
		value := args[0].String()
		name := args[1].String()
		respHeaders[name] = append(respHeaders[name], value)
		return nil
	})
	defer forEach.Release()

	resp.Get("headers").Call("forEach", forEach)
	return respHeaders
}

func (c *fetchHTTPClient) extractBody(resp js.Value) ([]byte, error) {
	arrayBuffer, err := awaitPromise(resp.Call("arrayBuffer"))
	if err != nil {
		return nil, err
	}

	uint8Array := js.Global().Get("Uint8Array").New(arrayBuffer)
	respBody := make([]byte, uint8Array.Get("byteLength").Int())
	js.CopyBytesToGo(respBody, uint8Array)

	return respBody, nil
}

func redirectMode(enabled bool) string {
	if enabled {
		return "follow"
	}
	return "manual"
}

// ---------------------------------------------------------------------------
// Inbound HTTP listener (no socket; requests are injected from JS).
// ---------------------------------------------------------------------------

// listenerRegistry holds the platform-neutral http.Handler built by the http
// stdlib, keyed by "host:port". In the browser there is no socket: dispatchHttp
// (main_wasm.go) looks the handler up here and runs requests through it directly.
type listenerRegistry struct {
	mu       sync.RWMutex
	handlers map[string]http.Handler
}

func newListenerRegistry() *listenerRegistry {
	return &listenerRegistry{handlers: map[string]http.Handler{}}
}

func (r *listenerRegistry) add(key string, h http.Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[key] = h
}

func (r *listenerRegistry) remove(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.handlers, key)
}

// handlerFor returns the handler bound to the exact host:port, falling back to
// the sole registered handler when only one listener exists (so a request that
// omits or mismatches the host still reaches a single-service program).
func (r *listenerRegistry) handlerFor(key string) (http.Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if h, ok := r.handlers[key]; ok {
		return h, true
	}
	if len(r.handlers) == 1 {
		for _, h := range r.handlers {
			return h, true
		}
	}
	return nil, false
}

// addrs returns the host:port keys of every active listener.
func (r *listenerRegistry) addrs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	return out
}

// wasmServerHandle is the pal.ServerHandle for a browser listener. Shutdown and
// Close both simply deregister the handler — there is no transport to drain.
type wasmServerHandle struct {
	key      string
	registry *listenerRegistry
}

func (h *wasmServerHandle) Shutdown(context.Context) error {
	h.registry.remove(h.key)
	return nil
}

func (h *wasmServerHandle) Close() error {
	h.registry.remove(h.key)
	return nil
}

// ---------------------------------------------------------------------------
// Platform assembly.
// ---------------------------------------------------------------------------

// wasmController exposes the browser-specific seams the JS bridge drives:
// the signal channel (to request a graceful stop) and the listener registry
// (to dispatch injected requests).
type wasmController struct {
	signals  chan pal.Signal
	registry *listenerRegistry
}

// wasmPal builds the browser pal.Platform and the controller that the JS bridge
// uses to inject requests and request shutdown. fsys backs the filesystem seam
// (the same project FS used to load the program).
func wasmPal(stderr, stdout io.Writer, fsys *bridgeFS) (pal.Platform, *wasmController) {
	ctrl := &wasmController{
		signals:  make(chan pal.Signal, 1),
		registry: newListenerRegistry(),
	}

	platform := pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: pal.FS{
			ReadFile: func(path string) ([]byte, error) {
				return fs.ReadFile(fsys, path)
			},
			WriteFile: func(path string, data []byte) error {
				return fsys.WriteFile(path, data, 0o644)
			},
			AppendFile: func(path string, data []byte) error {
				existing, err := fs.ReadFile(fsys, path)
				if err != nil {
					existing = nil
				}
				return fsys.WriteFile(path, append(existing, data...), 0o644)
			},
		},
		OS: pal.OS{
			GetEnv:      func(string) string { return "" },
			GetUsername: func() string { return "" },
			GetUserHome: func() string { return "" },
			SetEnv:      func(string, string) error { return nil },
			UnsetEnv:    func(string) error { return nil },
			ListEnv:     func() map[string]string { return map[string]string{} },
			// Exec is intentionally nil: subprocesses are not available in the browser.
		},
		Time: pal.Time{
			Now:          time.Now,
			MonotonicNow: func() time.Duration { return time.Since(processStart) },
		},
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) pal.HTTPClient {
				return &fetchHTTPClient{cfg: cfg}
			},
			Listen: func(cfg pal.ServerConfig, handler http.Handler) (pal.ServerHandle, error) {
				key := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
				ctrl.registry.add(key, handler)
				return &wasmServerHandle{key: key, registry: ctrl.registry}, nil
			},
		},
		Signals: pal.SignalSource{Signals: ctrl.signals},
	}

	return platform, ctrl
}

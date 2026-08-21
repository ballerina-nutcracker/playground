package main

import (
	"context"
	"github.com/ballerina-nutcracker/ballerina/platform/pal"
	"net/http"
)

type wasmListenerHandle struct {
	cfg pal.ServerConfig
}

func (w *wasmListenerHandle) Close() error {
	activeRun.unregisterListener(w.cfg)
	return nil
}

func (w *wasmListenerHandle) Shutdown(ctx context.Context) error {
	activeRun.unregisterListener(w.cfg)
	return nil
}

func listen(cfg pal.ServerConfig, handler http.Handler) (pal.ServerHandle, error) {
	return activeRun.registerListener(cfg, handler)
}

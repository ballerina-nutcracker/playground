package main

import (
	"ballerina/platform/pal"
	"context"
	"net/http"
	"reflect"
	"testing"
)

func TestRunContextListenerLifecycle(t *testing.T) {
	ctx := useTestRunContext(t)
	cfg := pal.ServerConfig{Host: "localhost", Port: 9090}
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})

	handle, err := ctx.registerListener(cfg, handler)
	if err != nil {
		t.Fatalf("register listener: %v", err)
	}
	if got, ok := ctx.getHandler("localhost:9090"); !ok || reflect.ValueOf(got).Pointer() != reflect.ValueOf(handler).Pointer() {
		t.Error("registered listener was not returned")
	}
	if _, err := ctx.registerListener(cfg, handler); err == nil {
		t.Fatal("expected duplicate listener registration to fail")
	}

	if err := handle.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	if _, ok := ctx.getHandler("localhost:9090"); ok {
		t.Error("closed listener is still registered")
	}

	handle, err = ctx.registerListener(cfg, handler)
	if err != nil {
		t.Fatalf("register listener again: %v", err)
	}
	if err := handle.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown listener: %v", err)
	}
	if _, ok := ctx.getHandler("localhost:9090"); ok {
		t.Error("shutdown listener is still registered")
	}
}

func TestRunContextHostsAreSorted(t *testing.T) {
	ctx := useTestRunContext(t)
	for _, cfg := range []pal.ServerConfig{
		{Host: "localhost", Port: 9091},
		{Host: "localhost", Port: 9090},
		{Host: "127.0.0.1", Port: 9090},
	} {
		registerTestHandler(t, ctx, cfg, http.NotFoundHandler())
	}

	want := []any{"127.0.0.1:9090", "localhost:9090", "localhost:9091"}
	if got := ctx.hosts(); !reflect.DeepEqual(got, want) {
		t.Errorf("hosts = %v, want %v", got, want)
	}
}

func TestListenerHostFormatsIPv6(t *testing.T) {
	cfg := pal.ServerConfig{Host: "::1", Port: 9090}
	if got, want := listenerHost(cfg), "[::1]:9090"; got != want {
		t.Errorf("listener host = %q, want %q", got, want)
	}
}

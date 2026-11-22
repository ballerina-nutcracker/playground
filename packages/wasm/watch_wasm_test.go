package main

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"syscall/js"
	"testing"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

type watchProxy struct {
	callbacks map[string]js.Value
	closed    int
	reject    bool
	onClose   chan struct{}
}

func newWatchProxy(t *testing.T) (*bridgeFS, *watchProxy) {
	t.Helper()
	state := &watchProxy{callbacks: make(map[string]js.Value)}
	nextID := 0
	watch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if state.reject {
			return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New("registration failed"))
		}
		nextID++
		id := fmt.Sprint(nextID)
		state.callbacks[id] = args[2]
		return js.Global().Get("Promise").Call("resolve", id)
	})
	unwatch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		delete(state.callbacks, args[0].String())
		state.closed++
		if state.onClose != nil {
			state.onClose <- struct{}{}
		}
		return js.Global().Get("Promise").Call("resolve", js.Undefined())
	})
	proxy := js.Global().Get("Object").New()
	proxy.Set("watch", watch)
	proxy.Set("unwatch", unwatch)
	bridge := NewBridgeFS(proxy)
	t.Cleanup(func() {
		_ = bridge.Close()
		watch.Release()
		unwatch.Release()
	})
	return bridge, state
}

func sendWatchBatch(callback js.Value, events ...map[string]any) js.Value {
	batch := make([]any, len(events))
	for i, event := range events {
		batch[i] = event
	}
	return callback.Invoke(batch)
}

func watchEvent(path, op string) map[string]any {
	return map[string]any{"path": path, "op": op}
}

func awaitAck(t *testing.T, ack js.Value) {
	t.Helper()
	if ack.Type() != js.TypeObject {
		t.Fatalf("watch callback returned %v, want a promise", ack.Type())
	}
	acked := make(chan struct{})
	onAck := js.FuncOf(func(js.Value, []js.Value) any {
		close(acked)
		return nil
	})
	defer onAck.Release()
	ack.Call("then", onAck)
	select {
	case <-acked:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the batch to be acknowledged")
	}
}

func receiveWatchEvent(t *testing.T, events <-chan pal.WatchEvent) pal.WatchEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for watch event")
		return pal.WatchEvent{}
	}
}

func TestWatchDispatchAndCleanup(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	events := make(chan pal.WatchEvent, 3)
	handle, err := bridge.Watch("/work", true, func(event pal.WatchEvent) {
		// Handlers can use the filesystem mutex; the JS callback must not.
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		events <- event
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge.mu.Lock()
	ack := sendWatchBatch(proxy.callbacks["1"],
		watchEvent("/work/file", "create"),
		watchEvent("/work/file", "modify"),
		watchEvent("/work/file", "delete"),
	)
	bridge.mu.Unlock()
	for _, op := range []pal.WatchOp{pal.WatchCreate, pal.WatchModify, pal.WatchDelete} {
		event := receiveWatchEvent(t, events)
		if event.Path != "/work/file" || event.Op != op || event.Err != nil {
			t.Fatalf("unexpected event: %+v", event)
		}
	}
	awaitAck(t, ack)
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	if proxy.closed != 1 || len(proxy.callbacks) != 0 || len(bridge.watches) != 0 {
		t.Fatal("Close must unsubscribe and release the handle exactly once")
	}
}

func TestWatchHandlerCanCloseItself(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	events := make(chan pal.WatchEvent, 1)
	var handle pal.WatchHandle
	var err error
	handle, err = bridge.Watch("/work", false, func(event pal.WatchEvent) {
		if closeErr := handle.Close(); closeErr != nil {
			event.Err = closeErr
		}
		events <- event
	})
	if err != nil {
		t.Fatal(err)
	}
	sendWatchBatch(proxy.callbacks["1"], watchEvent("/work/file", "create"))
	if event := receiveWatchEvent(t, events); event.Err != nil {
		t.Fatal(event.Err)
	}
	if proxy.closed != 1 {
		t.Fatal("handler did not close its watch")
	}
}

func TestWatchDeliversLargeBatchInOrder(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	const count = 1000
	events := make(chan pal.WatchEvent, count)
	if _, err := bridge.Watch("/work", true, func(event pal.WatchEvent) {
		events <- event
	}); err != nil {
		t.Fatal(err)
	}
	batch := make([]map[string]any, count)
	for i := range batch {
		batch[i] = watchEvent(fmt.Sprintf("/work/%d", i), "delete")
	}
	awaitAck(t, sendWatchBatch(proxy.callbacks["1"], batch...))
	for i := range count {
		event := receiveWatchEvent(t, events)
		if event.Err != nil || event.Path != fmt.Sprintf("/work/%d", i) {
			t.Fatalf("event %d: unexpected %+v", i, event)
		}
	}
}

func TestWatchRejectsBatchSentBeforePreviousIsAccepted(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	started := make(chan pal.WatchEvent, 1)
	resume := make(chan struct{})
	defer close(resume)
	failures := make(chan pal.WatchEvent, 1)
	first := true
	_, err := bridge.Watch("/work", false, func(event pal.WatchEvent) {
		if event.Err != nil {
			failures <- event
			return
		}
		if first {
			first = false
			started <- event
			<-resume
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	callback := proxy.callbacks["1"]
	awaitAck(t, sendWatchBatch(callback, watchEvent("/work/first", "create")))
	receiveWatchEvent(t, started)
	sendWatchBatch(callback, watchEvent("/work/second", "create"))
	awaitAck(t, sendWatchBatch(callback, watchEvent("/work/third", "create")))
	resume <- struct{}{}
	event := receiveWatchEvent(t, failures)
	if event.Err == nil || !strings.Contains(event.Err.Error(), "overflow") {
		t.Fatalf("expected an overflow error, got %+v", event)
	}
	if event.Path != "" {
		t.Fatal("error events must not contain a path")
	}
	if err := bridge.Close(); err != nil {
		t.Fatal(err)
	}
	if proxy.closed != 1 {
		t.Fatal("failed watch was not released")
	}
}

func TestWatchCloseAcknowledgesPendingBatch(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	started := make(chan pal.WatchEvent, 1)
	resume := make(chan struct{})
	handle, err := bridge.Watch("/work", false, func(event pal.WatchEvent) {
		started <- event
		<-resume
	})
	if err != nil {
		t.Fatal(err)
	}
	callback := proxy.callbacks["1"]
	sendWatchBatch(callback, watchEvent("/work/first", "create"))
	receiveWatchEvent(t, started)
	pending := sendWatchBatch(callback, watchEvent("/work/second", "create"))
	closed := make(chan error, 1)
	go func() { closed <- handle.Close() }()
	awaitAck(t, pending)
	close(resume)
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-started:
		t.Fatalf("closed watch delivered %+v", event)
	default:
	}
}

func TestWatchRegistrationFailureAndBridgeDisposal(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	proxy.reject = true
	if handle, err := bridge.Watch("/work", false, func(pal.WatchEvent) {}); handle != nil || err == nil {
		t.Fatal("registration failure must return an error and no handle")
	}
	if len(bridge.watches) != 0 {
		t.Fatal("failed registration was retained")
	}
	proxy.reject = false
	for i := 0; i < 2; i++ {
		if _, err := bridge.Watch("/work", false, func(pal.WatchEvent) {}); err != nil {
			t.Fatal(err)
		}
	}
	if err := bridge.Close(); err != nil {
		t.Fatal(err)
	}
	if len(proxy.callbacks) != 0 || proxy.closed != 2 {
		t.Fatal("bridge disposal must close every watch")
	}
	if _, err := bridge.Watch("/work", false, func(pal.WatchEvent) {}); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("disposed bridge accepted a watch: %v", err)
	}
}

func TestBridgeDisposalWaitsForInFlightHandler(t *testing.T) {
	t.Parallel()
	bridge, proxy := newWatchProxy(t)
	proxy.onClose = make(chan struct{}, 1)
	started := make(chan pal.WatchEvent, 1)
	resume := make(chan struct{})
	defer close(resume)
	_, err := bridge.Watch("/work", false, func(event pal.WatchEvent) {
		started <- event
		<-resume
	})
	if err != nil {
		t.Fatal(err)
	}
	sendWatchBatch(proxy.callbacks["1"], watchEvent("/work/file", "create"))
	receiveWatchEvent(t, started)
	closed := make(chan struct{})
	go func() {
		_ = bridge.Close()
		close(closed)
	}()
	<-proxy.onClose
	select {
	case <-closed:
		t.Fatal("bridge disposed while a handler still needs its filesystem proxy")
	default:
	}
	resume <- struct{}{}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not finish disposal")
	}
}

func TestWatchEventValidation(t *testing.T) {
	t.Parallel()
	for _, value := range []any{
		nil, true, "invalid",
		map[string]any{"path": 12, "op": "create"},
		map[string]any{"path": "/work/file", "op": "unknown"},
		map[string]any{"error": "directory removed"},
	} {
		if _, err := watchEventFromJS(js.ValueOf(value)); err == nil {
			t.Fatalf("accepted invalid/error event: %v", value)
		}
		if _, err := watchEventsFromJS([]js.Value{js.ValueOf([]any{value})}); err == nil {
			t.Fatalf("accepted a batch containing invalid/error event: %v", value)
		}
	}
	for _, args := range [][]js.Value{
		nil,
		{js.ValueOf(map[string]any{"path": "/work/file", "op": "create"})},
		{js.ValueOf([]any{}), js.ValueOf([]any{})},
	} {
		if _, err := watchEventsFromJS(args); err == nil {
			t.Fatalf("accepted invalid batch arguments: %v", args)
		}
	}
}

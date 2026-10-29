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
	"errors"
	"fmt"
	"io/fs"
	"sync"
	"sync/atomic"
	"syscall/js"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

const watchQueueLimit = 256

type wasmWatchHandle struct {
	fsys     *bridgeFS
	path     string
	id       string
	callback js.Func
	events   chan pal.WatchEvent
	failure  chan error
	done     chan struct{}
	closed   atomic.Bool
	close    sync.Once
	closeErr error
}

func (l *bridgeFS) Watch(path string, recursive bool, handler pal.WatchHandler) (pal.WatchHandle, error) {
	l.watchesMu.Lock()
	defer l.watchesMu.Unlock()
	if l.closed {
		return nil, &fs.PathError{Op: "watch", Path: path, Err: fs.ErrClosed}
	}

	w := &wasmWatchHandle{
		fsys: l, path: path,
		events:  make(chan pal.WatchEvent, watchQueueLimit),
		failure: make(chan error, 1),
		done:    make(chan struct{}),
	}
	w.callback = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if w.closed.Load() {
			return nil
		}
		event, err := watchEventFromJS(args)
		if err != nil {
			w.fail(err)
			return nil
		}
		select {
		case w.events <- event:
		default:
			w.fail(errors.New("directory watch event queue overflow"))
		}
		return nil
	})

	id, err := l.bridgeCall("watch", path, path, recursive, w.callback)
	if err != nil {
		w.callback.Release()
		return nil, err
	}
	if id.Type() != js.TypeString {
		w.callback.Release()
		return nil, fmt.Errorf("watch %s: invalid subscription ID", path)
	}
	w.id = id.String()
	l.watches[w] = struct{}{}
	l.watchDispatch.Add(1)
	go func() {
		defer l.watchDispatch.Done()
		w.dispatch(handler)
	}()
	return w, nil
}

func watchEventFromJS(args []js.Value) (pal.WatchEvent, error) {
	if len(args) != 1 || args[0].Type() != js.TypeObject || args[0].IsNull() {
		return pal.WatchEvent{}, errors.New("invalid directory watch event")
	}
	value := args[0]
	if message := value.Get("error"); message.Type() == js.TypeString {
		return pal.WatchEvent{}, errors.New(message.String())
	}
	path, op := value.Get("path"), value.Get("op")
	if path.Type() != js.TypeString || op.Type() != js.TypeString {
		return pal.WatchEvent{}, errors.New("invalid directory watch event")
	}
	event := pal.WatchEvent{Path: path.String()}
	switch op.String() {
	case "create":
		event.Op = pal.WatchCreate
	case "modify":
		event.Op = pal.WatchModify
	case "delete":
		event.Op = pal.WatchDelete
	default:
		return pal.WatchEvent{}, fmt.Errorf("invalid directory watch operation: %s", op.String())
	}
	return event, nil
}

func (w *wasmWatchHandle) fail(err error) {
	select {
	case w.failure <- err:
	default:
	}
}

func (w *wasmWatchHandle) dispatch(handler pal.WatchHandler) {
	defer w.Close()
	for {
		select {
		case <-w.done:
			return
		case err := <-w.failure:
			if !w.closed.Load() {
				handler(pal.WatchEvent{Err: err})
			}
			return
		case event := <-w.events:
			if w.closed.Load() {
				return
			}
			handler(event)
		}
	}
}

func (w *wasmWatchHandle) Close() error {
	w.close.Do(func() {
		w.closed.Store(true)
		close(w.done)
		_, w.closeErr = w.fsys.bridgeCall("unwatch", w.path, w.id)
		w.callback.Release()
		w.fsys.watchesMu.Lock()
		delete(w.fsys.watches, w)
		w.fsys.watchesMu.Unlock()
	})
	return w.closeErr
}

func (l *bridgeFS) Close() error {
	l.watchesMu.Lock()
	l.closed = true
	watches := make([]*wasmWatchHandle, 0, len(l.watches))
	for w := range l.watches {
		watches = append(watches, w)
	}
	l.watchesMu.Unlock()

	var err error
	for _, w := range watches {
		err = errors.Join(err, w.Close())
	}
	l.watchDispatch.Wait()
	return err
}

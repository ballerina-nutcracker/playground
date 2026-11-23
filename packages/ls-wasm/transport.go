package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

const maxMessageBytes = 16 << 20

func frameMessage(message string) ([]byte, error) {
	if len(message) > maxMessageBytes {
		return nil, fmt.Errorf("language server message exceeds %d bytes", maxMessageBytes)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(message), &object); err != nil || object == nil {
		return nil, fmt.Errorf("language server message must be a JSON object")
	}
	// Go string length counts UTF-8 bytes, unlike JavaScript string.length.
	return []byte(fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(message), message)), nil
}

// messageQueue is an ordered, nonblocking ingress. JS callbacks must never wait
// for Serve to read an io.Pipe: that can deadlock the shared WASM event loop.
type messageQueue struct {
	mu     sync.Mutex
	ready  *sync.Cond
	frames [][]byte
	closed bool
}

func newMessageQueue() *messageQueue {
	q := &messageQueue{}
	q.ready = sync.NewCond(&q.mu)
	return q
}

func (q *messageQueue) enqueue(message string) error {
	frame, err := frameMessage(message)
	if err != nil {
		return err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return fmt.Errorf("language server session has ended")
	}
	q.frames = append(q.frames, frame)
	q.ready.Signal()
	return nil
}

func (q *messageQueue) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.frames) == 0 && !q.closed {
		q.ready.Wait()
	}
	if len(q.frames) == 0 {
		return 0, io.EOF
	}
	n := copy(p, q.frames[0])
	q.frames[0] = q.frames[0][n:]
	if len(q.frames[0]) == 0 {
		q.frames[0] = nil
		q.frames = q.frames[1:]
	}
	return n, nil
}

func (q *messageQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.ready.Broadcast()
	q.mu.Unlock()
}

// frameDecoder accepts arbitrary write boundaries and removes stream framing
// without decoding/re-encoding the JSON body (responses have no method field).
type frameDecoder struct {
	pending []byte
	onJSON  func(string)
}

func (d *frameDecoder) Write(p []byte) (int, error) {
	d.pending = append(d.pending, p...)
	for {
		headerEnd := bytes.Index(d.pending, []byte("\r\n\r\n"))
		if headerEnd < 0 {
			if len(d.pending) > 8192 {
				return 0, fmt.Errorf("language server output header too large")
			}
			return len(p), nil
		}
		length := -1
		for _, line := range strings.Split(string(d.pending[:headerEnd]), "\r\n") {
			name, value, ok := strings.Cut(line, ":")
			if ok && strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
				var err error
				length, err = strconv.Atoi(strings.TrimSpace(value))
				if err != nil || length < 0 || length > maxMessageBytes {
					return 0, fmt.Errorf("invalid language server output Content-Length")
				}
			}
		}
		if length < 0 {
			return 0, fmt.Errorf("missing language server output Content-Length")
		}
		end := headerEnd + 4 + length
		if len(d.pending) < end {
			return len(p), nil
		}
		body := string(d.pending[headerEnd+4 : end])
		d.pending = d.pending[end:]
		d.onJSON(body)
	}
}

type serverTransport struct {
	*messageQueue
	output frameDecoder
}

func (t *serverTransport) Write(p []byte) (int, error) {
	// server.Server serializes all writes, including asynchronous diagnostics.
	return t.output.Write(p)
}

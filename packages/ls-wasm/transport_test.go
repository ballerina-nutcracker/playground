package main

import (
	"bufio"
	"bytes"
	"io"
	"reflect"
	"testing"

	"github.com/ballerina-nutcracker/ballerina/ls/protocol"
)

func TestFramingUTF8(t *testing.T) {
	message := `{"jsonrpc":"2.0","method":"example","params":{"text":"🐘 café"}}`
	frame, err := frameMessage(message)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := protocol.ReadMessage(bufio.NewReader(bytes.NewReader(frame)))
	if err != nil || parsed.Method != "example" {
		t.Fatalf("server cannot read UTF-8 frame: %v, %v", parsed, err)
	}
	if !bytes.Contains(frame, []byte("🐘 café")) {
		t.Fatal("framing changed the body")
	}
}

func TestOutputSplitAndCoalescedFrames(t *testing.T) {
	messages := []string{`{"id":1,"result":"🐘"}`, `{"method":"note","params":"é"}`}
	var stream []byte
	for _, message := range messages {
		frame, _ := frameMessage(message)
		stream = append(stream, frame...)
	}
	for _, chunkSize := range []int{1, 7, len(stream)} {
		var got []string
		d := frameDecoder{onJSON: func(s string) { got = append(got, s) }}
		for offset := 0; offset < len(stream); offset += chunkSize {
			end := min(offset+chunkSize, len(stream))
			if _, err := d.Write(stream[offset:end]); err != nil {
				t.Fatal(err)
			}
		}
		if !reflect.DeepEqual(got, messages) {
			t.Fatalf("chunk size %d: got %v", chunkSize, got)
		}
	}
}

func TestQueueOrderAndValidation(t *testing.T) {
	q := newMessageQueue()
	for _, message := range []string{`{"id":1}`, `{"id":2}`, `{"id":3}`} {
		if err := q.enqueue(message); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{"[1]", "null", "broken", "{}{}"} {
		if err := q.enqueue(invalid); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
	q.close()
	all, err := io.ReadAll(q)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(bytes.NewReader(all))
	for _, id := range []string{"1", "2", "3"} {
		message, err := protocol.ReadMessage(r)
		if err != nil || string(message.ID) != id {
			t.Fatalf("got id %s, %v; want %s", message.ID, err, id)
		}
	}
	if err := q.enqueue(`{}`); err == nil {
		t.Fatal("accepted a message after close")
	}
}

func TestOutputRejectsInvalidHeaders(t *testing.T) {
	for _, header := range []string{"Content-Length: -1", "Content-Length: nope", "Content-Type: json"} {
		d := frameDecoder{onJSON: func(string) { t.Fatal("unexpected output") }}
		if _, err := d.Write([]byte(header + "\r\n\r\n")); err == nil {
			t.Fatalf("accepted %q", header)
		}
	}
}

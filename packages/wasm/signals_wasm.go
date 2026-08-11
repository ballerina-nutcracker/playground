package main

import (
	"ballerina/platform/pal"
	"sync"
)

type signalSource struct {
	mu sync.Mutex

	ch            chan pal.Signal
	stopRequested bool
	closed        bool
}

func (s *signalSource) send(sig pal.Signal) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.stopRequested {
		return false
	}

	s.ch <- sig
	s.stopRequested = true
	return true
}

func (s *signalSource) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.ch)
}

func newSignalSource() (*signalSource, pal.SignalSource) {
	ch := make(chan pal.Signal, 1)
	return &signalSource{ch: ch}, pal.SignalSource{Signals: ch}
}

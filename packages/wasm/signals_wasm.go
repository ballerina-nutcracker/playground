package main

import "ballerina/platform/pal"

type signalSource struct {
	ch chan pal.Signal
}

func (s *signalSource) send(sig pal.Signal) bool {
	select {
	case s.ch <- sig:
		return true
	default:
		return false
	}
}

func (s *signalSource) cleanup() {
	close(s.ch)
}

func newSignalSource() (*signalSource, pal.SignalSource) {
	ch := make(chan pal.Signal, 2)
	return &signalSource{ch: ch}, pal.SignalSource{Signals: ch}
}

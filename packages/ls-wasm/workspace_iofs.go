//go:build ls_iofs

package main

import (
	"github.com/ballerina-nutcracker/ballerina/ls/core/event"
	"github.com/ballerina-nutcracker/ballerina/ls/core/workspace"
)

func newProjectService(f *memoryFS, bus *event.Bus) *workspace.ProjectService {
	return workspace.New(f.openDir, bus)
}

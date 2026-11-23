//go:build !ls_iofs

package main

import (
	"bytes"
	"io"
	"io/fs"
	"time"

	"github.com/ballerina-nutcracker/ballerina/ls/core/event"
	"github.com/ballerina-nutcracker/ballerina/ls/core/workspace"
	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

func newProjectService(f *memoryFS, bus *event.Bus) *workspace.ProjectService {
	platform := pal.Platform{
		FS: pal.FS{
			Stat: f.stat, ReadFile: f.readFile, ReadDir: f.readDir,
			OpenReadable: func(name string) (io.ReadCloser, error) {
				data, err := f.readFile(name)
				if err != nil {
					return nil, err
				}
				return io.NopCloser(bytes.NewReader(data)), nil
			},
			WriteFile:    func(name string, _ []byte) error { return readOnly(name) },
			AppendFile:   func(name string, _ []byte) error { return readOnly(name) },
			MkdirAll:     func(name string, _ fs.FileMode) error { return readOnly(name) },
			OpenWritable: func(name string, _ bool) (io.WriteCloser, error) { return nil, readOnly(name) },
		},
		Time: pal.Time{Now: time.Now},
	}
	return workspace.New(platform, bus)
}

func readOnly(name string) error {
	return &fs.PathError{Op: "write", Path: name, Err: fs.ErrPermission}
}

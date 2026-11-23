package main

import (
	"errors"
	"io"
	"io/fs"
	"sync"
	"testing"
	"testing/fstest"
)

func text(s string) *string { return &s }

func TestFilesystemSnapshot(t *testing.T) {
	f := newMemoryFS()
	if err := f.replace([]fileEntry{
		{Path: "project/Ballerina.toml", Content: text("[package]")},
		{Path: "/workspace/project/main.bal", Content: text("hello 🐘")},
		{Path: "project/modules/math", IsDir: true},
	}); err != nil {
		t.Fatal(err)
	}
	entries, err := f.readDir("/workspace/project")
	if err != nil || len(entries) != 3 {
		t.Fatalf("ReadDir = %v, %v", entries, err)
	}
	if entries[0].Name() != "Ballerina.toml" || entries[1].Name() != "main.bal" || !entries[2].IsDir() {
		t.Fatalf("entries not sorted or missing directories: %v", entries)
	}
	data, err := f.readFile("/workspace/project/main.bal")
	if err != nil || string(data) != "hello 🐘" {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
	data[0] = 'X'
	data, _ = f.readFile("project/main.bal")
	if string(data) != "hello 🐘" {
		t.Fatal("caller mutated the snapshot")
	}
	reader, err := f.openDir(workspaceRoot).Open("project/main.bal")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if err := f.replace(nil); err != nil {
		t.Fatal(err)
	}
	// Streaming handles retain the snapshot from their open operation.
	data, _ = io.ReadAll(reader)
	if string(data) != "hello 🐘" {
		t.Fatal("replacement changed an open handle")
	}
	if _, err := f.stat("project/main.bal"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("deleted file still exists: %v", err)
	}
}

func TestDirectoryFilesystem(t *testing.T) {
	f := newMemoryFS()
	if err := f.replace([]fileEntry{
		{Path: "project/Ballerina.toml", Content: text("[package]")},
		{Path: "project/modules/math/main.bal", Content: text("function main() {}")},
	}); err != nil {
		t.Fatal(err)
	}
	if err := fstest.TestFS(f.openDir("/workspace/project"), "Ballerina.toml", "modules/math/main.bal"); err != nil {
		t.Fatal(err)
	}
}

func TestFilesystemRejectsInvalidUpdateAtomically(t *testing.T) {
	cases := [][]fileEntry{
		{{Path: "../escape", Content: text("bad")}},
		{{Path: "/outside/main.bal"}},
		{{Path: "a\\b"}},
		{{Path: "a", IsDir: true, Content: text("bad")}},
		{{Path: "a"}, {Path: "a/b"}},
		{{Path: "a/b"}, {Path: "a"}},
		{{Path: "same"}, {Path: "/workspace/same"}},
		{{Path: "/workspace"}},
	}
	f := newMemoryFS()
	_ = f.replace([]fileEntry{{Path: "keep.bal", Content: text("old")}})
	for _, entries := range cases {
		if err := f.replace(entries); err == nil {
			t.Fatalf("accepted invalid update: %v", entries)
		}
		if data, err := f.readFile("keep.bal"); err != nil || string(data) != "old" {
			t.Fatalf("failed update replaced snapshot: %q, %v", data, err)
		}
	}
}

func TestFilesystemConcurrentReplace(t *testing.T) {
	f := newMemoryFS()
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 100 {
				_ = f.replace([]fileEntry{{Path: "a/file.bal", Content: text("text")}})
				_, _ = f.stat("a/file.bal")
				_, _ = f.readFile("a/file.bal")
				_, _ = f.readDir("a")
			}
		})
	}
	wg.Wait()
}

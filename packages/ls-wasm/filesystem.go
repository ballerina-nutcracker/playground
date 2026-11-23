package main

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
)

const workspaceRoot = "/workspace"

type fileEntry struct {
	Path    string  `json:"path"`
	Content *string `json:"content,omitempty"`
	IsDir   bool    `json:"isDir"`
}

type memoryNode struct {
	name string
	data string
	dir  bool
}

func (n memoryNode) Name() string       { return path.Base(n.name) }
func (n memoryNode) Size() int64        { return int64(len(n.data)) }
func (n memoryNode) ModTime() time.Time { return time.Time{} }
func (n memoryNode) IsDir() bool        { return n.dir }
func (n memoryNode) Sys() any           { return nil }
func (n memoryNode) Mode() fs.FileMode {
	if n.dir {
		return fs.ModeDir | 0o755
	}
	return 0o644
}

// Snapshots are immutable after publication. Each PAL operation observes one
// complete snapshot; invalid updates leave the previous snapshot untouched.
type memoryFS struct {
	mu    sync.RWMutex
	nodes map[string]memoryNode
}

func newMemoryFS() *memoryFS {
	f := &memoryFS{}
	_ = f.replace(nil)
	return f
}

func canonicalPath(name string) (string, error) {
	if strings.ContainsAny(name, "\\\x00") {
		return "", fmt.Errorf("invalid workspace path %q", name)
	}
	if strings.HasPrefix(name, "/") {
		if name != workspaceRoot && !strings.HasPrefix(name, workspaceRoot+"/") {
			return "", fmt.Errorf("path outside workspace: %q", name)
		}
		name = strings.TrimPrefix(strings.TrimPrefix(name, workspaceRoot), "/")
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == ".." {
			return "", fmt.Errorf("parent traversal in workspace path: %q", name)
		}
	}
	return path.Join(workspaceRoot, name), nil
}

func (f *memoryFS) replace(entries []fileEntry) error {
	nodes := map[string]memoryNode{
		"/": {name: "/", dir: true}, workspaceRoot: {name: workspaceRoot, dir: true},
	}
	seen := make(map[string]bool)
	for _, entry := range entries {
		name, err := canonicalPath(entry.Path)
		if err != nil {
			return err
		}
		if seen[name] {
			return fmt.Errorf("duplicate workspace entry: %s", name)
		}
		seen[name] = true
		if entry.IsDir && entry.Content != nil {
			return fmt.Errorf("directory has content: %s", name)
		}
		if existing, ok := nodes[name]; ok && existing.dir != entry.IsDir {
			return fmt.Errorf("file/directory conflict: %s", name)
		}
		data := ""
		if entry.Content != nil {
			data = *entry.Content
		}
		nodes[name] = memoryNode{name: name, data: data, dir: entry.IsDir}
		for parent := path.Dir(name); parent != "/"; parent = path.Dir(parent) {
			if existing, ok := nodes[parent]; ok && !existing.dir {
				return fmt.Errorf("file used as directory: %s", parent)
			}
			nodes[parent] = memoryNode{name: parent, dir: true}
		}
	}
	f.mu.Lock()
	f.nodes = nodes
	f.mu.Unlock()
	return nil
}

func lookupPath(name string) (string, error) {
	// Project discovery ascends to /, which exists but has no manifest.
	if name == "/" {
		return name, nil
	}
	return canonicalPath(name)
}

func (f *memoryFS) stat(name string) (fs.FileInfo, error) {
	key, err := lookupPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: fs.ErrNotExist}
	}
	f.mu.RLock()
	n, ok := f.nodes[key]
	f.mu.RUnlock()
	if !ok {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: fs.ErrNotExist}
	}
	return n, nil
}

func (f *memoryFS) readFile(name string) ([]byte, error) {
	info, err := f.stat(name)
	if err != nil {
		return nil, err
	}
	n := info.(memoryNode)
	if n.dir {
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrInvalid}
	}
	return []byte(n.data), nil
}

func (f *memoryFS) readDir(name string) ([]fs.DirEntry, error) {
	key, err := lookupPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	n, ok := f.nodes[key]
	if !ok {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
	}
	if !n.dir {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrInvalid}
	}
	entries := make([]fs.DirEntry, 0)
	for name, node := range f.nodes {
		if name != key && path.Dir(name) == key {
			entries = append(entries, fs.FileInfoToDirEntry(node))
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

// directoryFS exposes a live, read-only directory view using io/fs paths.
type directoryFS struct {
	files *memoryFS
	root  string
}

func (f *memoryFS) openDir(root string) fs.FS {
	return directoryFS{files: f, root: root}
}

func (d directoryFS) resolve(name string) (string, error) {
	if !fs.ValidPath(name) {
		return "", &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	return path.Join(d.root, name), nil
}

func (d directoryFS) Stat(name string) (fs.FileInfo, error) {
	full, err := d.resolve(name)
	if err != nil {
		return nil, err
	}
	return d.files.stat(full)
}

func (d directoryFS) ReadFile(name string) ([]byte, error) {
	full, err := d.resolve(name)
	if err != nil {
		return nil, err
	}
	return d.files.readFile(full)
}

func (d directoryFS) ReadDir(name string) ([]fs.DirEntry, error) {
	full, err := d.resolve(name)
	if err != nil {
		return nil, err
	}
	return d.files.readDir(full)
}

func (d directoryFS) Open(name string) (fs.File, error) {
	full, err := d.resolve(name)
	if err != nil {
		return nil, err
	}
	info, err := d.files.stat(full)
	if err != nil {
		return nil, err
	}
	node := info.(memoryNode)
	handle := &memoryFile{Reader: bytes.NewReader([]byte(node.data)), info: node}
	if node.dir {
		handle.entries, err = d.files.readDir(full)
		if err != nil {
			return nil, err
		}
	}
	return handle, nil
}

type memoryFile struct {
	*bytes.Reader
	info    memoryNode
	entries []fs.DirEntry
	offset  int
}

func (f *memoryFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *memoryFile) Close() error               { return nil }
func (f *memoryFile) ReadDir(n int) ([]fs.DirEntry, error) {
	if !f.info.dir {
		return nil, &fs.PathError{Op: "readdir", Path: f.info.name, Err: fs.ErrInvalid}
	}
	if n > 0 && f.offset >= len(f.entries) {
		return nil, io.EOF
	}
	end := len(f.entries)
	if n > 0 && n < end-f.offset {
		end = f.offset + n
	}
	entries := f.entries[f.offset:end]
	f.offset = end
	return entries, nil
}

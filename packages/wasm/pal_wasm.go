package main

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"maps"
	"net"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
	"uuid"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

var (
	processStart              = time.Now()
	errRawNetworkNotSupported = errors.New("Network sockets are not supported in Playground")
)

func resolvePath(cwd string, p string) string {
	if path.IsAbs(p) {
		return p
	}
	return path.Join(cwd, p)
}

type bufferedWriteCloser struct {
	fsys       *bridgeFS
	path       string
	appendMode bool
	buffer     []byte
	closed     bool
}

func (w *bufferedWriteCloser) Write(data []byte) (int, error) {
	if w.closed {
		return 0, errors.New("write to closed file")
	}
	w.buffer = append(w.buffer, data...)
	return len(data), nil
}

func (w *bufferedWriteCloser) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true

	w.fsys.mu.Lock()
	defer w.fsys.mu.Unlock()

	data := w.buffer
	if w.appendMode {
		existing, err := fs.ReadFile(w.fsys, w.path)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		data = append(existing, data...)
	}
	return w.fsys.WriteFile(w.path, data, 0o644)
}

type environment struct {
	mu     sync.RWMutex
	values map[string]string
}

func newEnvironment() *environment {
	return &environment{values: make(map[string]string)}
}

func (e *environment) get(key string) string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.values[key]
}

func (e *environment) set(key, value string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.values[key] = value
	return nil
}

func (e *environment) unset(key string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.values, key)
	return nil
}

func (e *environment) list() map[string]string {
	e.mu.RLock()
	defer e.mu.RUnlock()

	values := make(map[string]string, len(e.values))
	maps.Copy(values, e.values)
	return values
}

func createParentDirs(fsys *bridgeFS, p string) error {
	dir := path.Dir(p)
	info, err := fs.Stat(fsys, dir)
	if err == nil {
		if !info.IsDir() {
			return &fs.PathError{Op: "mkdirAll", Path: dir, Err: fs.ErrInvalid}
		}
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fsys.MkdirAll(dir, 0o755)
	}
	return err
}

// absolutePath resolves p against cwd without cleaning dot segments, matching
// Java's Path.toAbsolutePath behavior required by pal.FS.Abs.
func absolutePath(cwd, p string) string {
	if path.IsAbs(p) {
		return p
	}
	if p == "" {
		return cwd
	}
	if cwd == "/" {
		return "/" + p
	}
	return cwd + "/" + p
}

func wasmFileInfo(fsys *bridgeFS, p string) (*pal.FileInfo, error) {
	info, err := fs.Stat(fsys, p)
	if err != nil {
		return nil, err
	}
	return &pal.FileInfo{
		AbsPath:    p,
		Size:       info.Size(),
		ModifiedAt: info.ModTime(),
		IsDir:      info.IsDir(),
		IsReadable: true,
		IsWritable: true,
	}, nil
}

func copyWasmPath(fsys *bridgeFS, src, dst string, opts pal.CopyOptions) error {
	info, err := fs.Stat(fsys, src)
	if err != nil {
		return err
	}
	if src == dst {
		return nil
	}
	if info.IsDir() {
		cleanSrc := path.Clean(src)
		cleanDst := path.Clean(dst)
		if cleanSrc != cleanDst && strings.HasPrefix(cleanDst, strings.TrimSuffix(cleanSrc, "/")+"/") {
			return &fs.PathError{Op: "copy", Path: dst, Err: fs.ErrInvalid}
		}
		if dstInfo, err := fs.Stat(fsys, dst); err == nil && !dstInfo.IsDir() {
			return &fs.PathError{Op: "copy", Path: dst, Err: fs.ErrInvalid}
		}
		if err := fsys.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		entries, err := fs.ReadDir(fsys, src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyWasmPath(fsys, path.Join(src, entry.Name()), path.Join(dst, entry.Name()), opts); err != nil {
				return err
			}
		}
		return nil
	}

	if dstInfo, err := fs.Stat(fsys, dst); err == nil {
		if dstInfo.IsDir() || !opts.ReplaceExisting {
			return &fs.PathError{Op: "copy", Path: dst, Err: fs.ErrExist}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	parent, err := fs.Stat(fsys, path.Dir(dst))
	if err != nil {
		return err
	}
	if !parent.IsDir() {
		return &fs.PathError{Op: "copy", Path: dst, Err: fs.ErrInvalid}
	}
	contents, err := fs.ReadFile(fsys, src)
	if err != nil {
		return err
	}
	return fsys.WriteFile(dst, contents, 0o644)
}

func createWasmTemp(fsys *bridgeFS, cwd, prefix, suffix, dir string, isDir bool) (string, error) {
	if strings.Contains(prefix, "/") || strings.Contains(suffix, "/") {
		return "", &fs.PathError{Op: "createTemp", Path: dir, Err: fs.ErrInvalid}
	}
	if dir == "" {
		// The browser snapshot need not contain the host's default /tmp. The
		// working directory is always mounted and provides an isolated run-local
		// location for temporary files.
		dir = cwd
	}
	resolvedDir := resolvePath(cwd, dir)
	info, err := fs.Stat(fsys, resolvedDir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", &fs.PathError{Op: "createTemp", Path: resolvedDir, Err: fs.ErrInvalid}
	}

	for {
		name := path.Join(resolvedDir, prefix+"ballerina-"+uuid.NewV4().String()+suffix)
		if _, err := fs.Stat(fsys, name); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		if isDir {
			err = fsys.MkdirAll(name, 0o755)
		} else {
			err = fsys.WriteFile(name, nil, 0o644)
		}
		if err == nil {
			return name, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
}

func wasmPal(fsys *bridgeFS, cwd string, stderr, stdout io.Writer, signals pal.SignalSource) pal.Platform {
	env := newEnvironment()

	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: pal.FS{
			OpenReadable: func(p string) (io.ReadCloser, error) {
				return fsys.Open(resolvePath(cwd, p))
			},
			OpenWritable: func(p string, appendMode bool) (io.WriteCloser, error) {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolvedPath := resolvePath(cwd, p)
				if err := createParentDirs(fsys, resolvedPath); err != nil {
					return nil, err
				}
				if !appendMode {
					if err := fsys.WriteFile(resolvedPath, nil, 0o644); err != nil {
						return nil, err
					}
				}
				return &bufferedWriteCloser{
					fsys:       fsys,
					path:       resolvedPath,
					appendMode: appendMode,
				}, nil
			},
			ReadFile: func(p string) ([]byte, error) {
				return fs.ReadFile(fsys, resolvePath(cwd, p))
			},
			WriteFile: func(p string, data []byte) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolvedPath := resolvePath(cwd, p)
				if err := createParentDirs(fsys, resolvedPath); err != nil {
					return err
				}
				return fsys.WriteFile(resolvedPath, data, 0o644)
			},
			AppendFile: func(p string, data []byte) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				if err := createParentDirs(fsys, resolved); err != nil {
					return err
				}
				current, err := fs.ReadFile(fsys, resolved)
				if err != nil && !errors.Is(err, fs.ErrNotExist) {
					return err
				}
				return fsys.WriteFile(resolved, append(current, data...), 0o644)
			},
			Getwd: func() (string, error) {
				return cwd, nil
			},
			Abs: func(p string) (string, error) {
				return absolutePath(cwd, p), nil
			},
			Mkdir: func(p string) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				if _, err := fs.Stat(fsys, resolved); err == nil {
					return &fs.PathError{Op: "mkdir", Path: resolved, Err: fs.ErrExist}
				} else if !errors.Is(err, fs.ErrNotExist) {
					return err
				}
				parent, err := fs.Stat(fsys, path.Dir(resolved))
				if err != nil {
					return err
				}
				if !parent.IsDir() {
					return &fs.PathError{Op: "mkdir", Path: resolved, Err: fs.ErrInvalid}
				}
				return fsys.MkdirAll(resolved, 0o755)
			},
			MkdirAll: func(p string) error {
				return fsys.MkdirAll(resolvePath(cwd, p), 0o755)
			},
			Remove: func(p string) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				info, err := fs.Stat(fsys, resolved)
				if err != nil {
					return err
				}
				if info.IsDir() {
					entries, err := fs.ReadDir(fsys, resolved)
					if err != nil {
						return err
					}
					if len(entries) > 0 {
						return &fs.PathError{Op: "remove", Path: resolved, Err: syscall.ENOTEMPTY}
					}
				}
				return fsys.Remove(resolved)
			},
			RemoveAll: func(p string) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				if _, err := fs.Stat(fsys, resolved); errors.Is(err, fs.ErrNotExist) {
					return nil
				} else if err != nil {
					return err
				}
				return fsys.Remove(resolved)
			},
			Rename: func(oldPath, newPath string) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				oldResolved := resolvePath(cwd, oldPath)
				newResolved := resolvePath(cwd, newPath)
				if oldResolved != newResolved {
					if _, err := fs.Stat(fsys, newResolved); err == nil {
						return &fs.PathError{Op: "rename", Path: newResolved, Err: fs.ErrExist}
					} else if !errors.Is(err, fs.ErrNotExist) {
						return err
					}
				}
				return fsys.Move(oldResolved, newResolved)
			},
			CreateFile: func(p string) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				if _, err := fs.Stat(fsys, resolved); err == nil {
					return &fs.PathError{Op: "create", Path: resolved, Err: fs.ErrExist}
				} else if !errors.Is(err, fs.ErrNotExist) {
					return err
				}
				parent, err := fs.Stat(fsys, path.Dir(resolved))
				if err != nil {
					return err
				}
				if !parent.IsDir() {
					return &fs.PathError{Op: "create", Path: resolved, Err: fs.ErrInvalid}
				}
				return fsys.WriteFile(resolved, nil, 0o644)
			},
			Stat: func(p string) (*pal.FileInfo, error) {
				return wasmFileInfo(fsys, resolvePath(cwd, p))
			},
			Lstat: func(p string) (*pal.FileInfo, error) {
				return wasmFileInfo(fsys, resolvePath(cwd, p))
			},
			ReadDir: func(p string) ([]pal.FileInfo, error) {
				resolved := resolvePath(cwd, p)
				entries, err := fs.ReadDir(fsys, resolved)
				if err != nil {
					return nil, err
				}
				result := make([]pal.FileInfo, 0, len(entries))
				for _, entry := range entries {
					info, err := wasmFileInfo(fsys, path.Join(resolved, entry.Name()))
					if err != nil {
						return nil, err
					}
					result = append(result, *info)
				}
				return result, nil
			},
			Copy: func(src, dst string, opts pal.CopyOptions) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()
				return copyWasmPath(fsys, resolvePath(cwd, src), resolvePath(cwd, dst), opts)
			},
			CreateTemp: func(prefix, suffix, dir string) (string, error) {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()
				return createWasmTemp(fsys, cwd, prefix, suffix, dir, false)
			},
			CreateTempDir: func(prefix, suffix, dir string) (string, error) {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()
				return createWasmTemp(fsys, cwd, prefix, suffix, dir, true)
			},
			Readlink: func(p string) (string, error) {
				resolved := resolvePath(cwd, p)
				return "", &fs.PathError{Op: "readlink", Path: resolved, Err: fs.ErrInvalid}
			},
		},
		OS: pal.OS{
			GetEnv: env.get,
			GetUsername: func() string {
				panic("GetUsername is not supported in Playground")
			},
			GetUserHome: func() string {
				panic("GetUserHome is not supported in Playground")
			},
			SetEnv:   env.set,
			UnsetEnv: env.unset,
			ListEnv:  env.list,
			Exec: func(command string, args []string, envOverride map[string]string) (pal.ProcessHandle, error) {
				panic("Exec is not supported in Playground")
			},
		},
		Time: pal.Time{
			Now:          time.Now,
			MonotonicNow: func() time.Duration { return time.Since(processStart) },
		},
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) (pal.HTTPClient, error) {
				return &fetchHTTPClient{cfg: cfg}, nil
			},
			Listen: listen,
		},
		Net: pal.Net{
			Dial: func(_ context.Context, _, _, _ string, _ *pal.TLSConfig) (net.Conn, error) {
				return nil, errRawNetworkNotSupported
			},
			Listen: func(_, _ string, _ *pal.ServerTLSConfig) (net.Listener, error) {
				return nil, errRawNetworkNotSupported
			},
			DialPacket: func(_ context.Context, _, _, _ string) (net.Conn, error) {
				return nil, errRawNetworkNotSupported
			},
			ListenPacket: func(_, _ string) (net.PacketConn, error) {
				return nil, errRawNetworkNotSupported
			},
			ResolvePacketAddr: func(_, _ string) (net.Addr, error) {
				return nil, errRawNetworkNotSupported
			},
		},
		Signals: signals,
	}
}

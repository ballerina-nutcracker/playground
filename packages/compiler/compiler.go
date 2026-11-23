// Package compiler checks saved Ballerina projects without executing them.
package compiler

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/ballerina-nutcracker/ballerina/common/bfs"
	"github.com/ballerina-nutcracker/ballerina/common/tomlparser"
	"github.com/ballerina-nutcracker/ballerina/lib/langlibs"
	"github.com/ballerina-nutcracker/ballerina/lib/stdlibs"
	"github.com/ballerina-nutcracker/ballerina/projects"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

type Files map[string]string
type Severity string

const (
	Internal Severity = "internal"
	Hint     Severity = "hint"
	Info     Severity = "info"
	Warning  Severity = "warning"
	Error    Severity = "error"
	Fatal    Severity = "fatal"
)

type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}
type SourceRange struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}
type Diagnostic struct {
	Severity Severity     `json:"severity"`
	Code     string       `json:"code,omitempty"`
	Message  string       `json:"message"`
	File     string       `json:"file,omitempty"`
	Range    *SourceRange `json:"range,omitempty"`
}
type Result struct {
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// Check creates independent compilation state and never retains or writes files.
// Compiler panics are infrastructure failures, including recovered upstream panics.
func Check(files Files) (result Result, err error) {
	defer func() {
		if p := recover(); p != nil {
			result = Result{}
			err = fmt.Errorf("compiler panic: %v", p)
		}
	}()
	sources, validated, err := projectInput(files)
	result = validated
	if err != nil || len(result.Diagnostics) > 0 {
		return result, err
	}
	input := func(file, message string) Diagnostic {
		return Diagnostic{Severity: Error, Code: "PROJECT_INPUT", File: file, Message: message}
	}
	// Use only embedded libraries: no user caches, downloaded packages, or native
	// implementations are needed to check the project frontend.
	loaded, err := projects.Load(sources, ".", projects.ProjectLoadConfig{Repositories: []projects.Repository{
		projects.NewFileSystemRepository(langlibs.FS, "."), projects.NewFileSystemRepository(stdlibs.FS, "."),
	}})
	if err != nil {
		var projectErr *projects.ProjectError
		if errors.As(err, &projectErr) {
			result.Diagnostics = append(result.Diagnostics, input("", err.Error()))
			return result, nil
		}
		return Result{}, fmt.Errorf("load project: %w", err)
	}
	if loaded.Project() == nil {
		return Result{}, fmt.Errorf("compiler loader returned no project")
	}
	compilation := loaded.Project().CurrentPackage().Compilation()
	// Compilation already includes the manifest diagnostics emitted by Load.
	items := compilation.DiagnosticResult().Diagnostics()
	// Preserve any additional loading diagnostics without duplicating their entries.
	for _, d := range loaded.Diagnostics().Diagnostics() {
		found := false
		for _, c := range items {
			if d.Location() == c.Location() && d.Message() == c.Message() && d.DiagnosticInfo().Code() == c.DiagnosticInfo().Code() && d.DiagnosticInfo().Severity() == c.DiagnosticInfo().Severity() {
				found = true
				break
			}
		}
		if !found {
			items = append(items, d)
		}
	}
	normalizedSources, err := diagnosticSources(files)
	if err != nil {
		return Result{}, err
	}
	result.Diagnostics, err = normalizeDiagnostics(items, compilation.DiagnosticEnv(), normalizedSources)
	return result, err
}

// Hide the mutable adapter's methods from compiler consumers.
type readOnly struct{ fs.FS }

func (r readOnly) Open(name string) (fs.File, error) {
	file, err := r.FS.Open(name)
	if err != nil {
		return nil, err
	}
	if directory, ok := file.(fs.ReadDirFile); ok {
		return struct{ fs.ReadDirFile }{directory}, nil
	}
	return struct{ fs.File }{file}, nil
}

func sourceFS(files Files) (fs.FS, error) {
	mem := bfs.NewMemFS()
	for name := range files {
		if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\:\x00") || strings.IndexFunc(name, func(r rune) bool { return r < 32 }) >= 0 {
			return nil, fmt.Errorf("invalid source path %q", name)
		}
		for dir := path.Dir(name); dir != "."; dir = path.Dir(dir) {
			if _, exists := files[dir]; exists {
				return nil, fmt.Errorf("file/directory conflict: %q", dir)
			}
		}
	}
	for name, content := range files {
		if err := mem.WriteFile(name, []byte(content), 0o644); err != nil {
			return nil, err
		}
	}
	return readOnly{mem}, nil
}

// Build exact registered identities for bundled documents, never workspace aliases.
func diagnosticSources(files Files) (fs.FS, error) {
	mem := bfs.NewMemFS()
	for name, content := range files {
		if err := mem.WriteFile(name, []byte(content), 0o644); err != nil {
			return nil, err
		}
	}
	for _, bundle := range []fs.FS{langlibs.FS, stdlibs.FS} {
		err := fs.WalkDir(bundle, ".", func(name string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(name, ".bal") {
				return nil
			}
			parts := strings.Split(name, "/")
			var module, file string
			switch {
			case len(parts) == 5:
				module, file = parts[1], parts[4]
			case len(parts) == 7 && parts[4] == "modules":
				module, file = parts[1]+"."+parts[5], parts[6]
			default:
				return nil
			}
			content, err := fs.ReadFile(bundle, name)
			if err != nil {
				return err
			}
			key := parts[0] + "/" + module + "/" + parts[2] + "::" + file
			return mem.WriteFile(key, content, 0o644)
		})
		if err != nil {
			return nil, err
		}
	}
	return readOnly{mem}, nil
}

func normalizeDiagnostics(items []diagnostics.Diagnostic, env *diagnostics.DiagnosticEnv, sources fs.FS) ([]Diagnostic, error) {
	result := make([]Diagnostic, 0, len(items))
	for _, item := range items {
		info := item.DiagnosticInfo()
		severity := Severity(strings.ToLower(info.Severity().String()))
		if !slices.Contains([]Severity{Internal, Hint, Info, Warning, Error, Fatal}, severity) {
			return nil, fmt.Errorf("unknown compiler severity %v", info.Severity())
		}
		d := Diagnostic{Severity: severity, Code: info.Code(), Message: item.Message()}
		loc := item.Location()
		if !diagnostics.IsLocationEmpty(loc) {
			if env == nil {
				return nil, fmt.Errorf("missing diagnostic environment")
			}
			d.File = env.FileName(loc)
			if diagnostics.LocationHasSource(loc) {
				content, err := fs.ReadFile(sources, d.File)
				if err != nil {
					return nil, fmt.Errorf("resolve diagnostic document %q: %w", d.File, err)
				}
				if loc.EndOffset() < loc.StartOffset() {
					return nil, fmt.Errorf("reversed diagnostic range for %q", d.File)
				}
				start, err := position(string(content), loc.StartOffset())
				if err != nil {
					return nil, err
				}
				end, err := position(string(content), loc.EndOffset())
				if err != nil {
					return nil, err
				}
				d.Range = &SourceRange{Start: start, End: end}
			}
		}
		result = append(result, d)
	}
	sortDiagnostics(result)
	return result, nil
}
func sortDiagnostics(items []Diagnostic) {
	slices.SortStableFunc(items, func(a, b Diagnostic) int {
		ar, br := SourceRange{}, SourceRange{}
		if a.Range != nil {
			ar = *a.Range
		}
		if b.Range != nil {
			br = *b.Range
		}
		return cmp.Or(cmp.Compare(a.File, b.File), cmp.Compare(ar.Start.Line, br.Start.Line), cmp.Compare(ar.Start.Column, br.Start.Column), cmp.Compare(ar.End.Line, br.End.Line), cmp.Compare(ar.End.Column, br.End.Column), cmp.Compare(a.Severity, b.Severity), cmp.Compare(a.Code, b.Code), cmp.Compare(a.Message, b.Message))
	})
}
func position(source string, byteOffset int) (Position, error) {
	if byteOffset < 0 || byteOffset > len(source) || !utf8.ValidString(source) || (byteOffset < len(source) && !utf8.RuneStart(source[byteOffset])) {
		return Position{}, fmt.Errorf("invalid UTF-8 source offset %d", byteOffset)
	}
	p := Position{Line: 1, Column: 1}
	for i := 0; i < byteOffset; {
		r, size := utf8.DecodeRuneInString(source[i:])
		i += size
		if r == '\r' {
			p.Line++
			p.Column = 1
			if i < byteOffset && source[i] == '\n' {
				i++
			}
		} else if r == '\n' {
			if i < 2 || source[i-2] != '\r' {
				p.Line++
			}
			p.Column = 1
		} else {
			p.Column++
		}
	}
	return p, nil
}

func projectInput(files Files) (fs.FS, Result, error) {
	var result Result
	sources, err := sourceFS(files)
	if err != nil {
		return nil, Result{}, err
	}
	input := func(file, message string) Diagnostic {
		return Diagnostic{Severity: Error, Code: "PROJECT_INPUT", File: file, Message: message}
	}
	result.Diagnostics = []Diagnostic{}
	// Reject unsupported sources before loading: upstream test compilation is incomplete.
	for name := range files {
		parts := strings.Split(name, "/")
		test := parts[0] == "tests" || (len(parts) >= 4 && parts[0] == "modules" && parts[2] == "tests")
		resource := parts[0] == "resources" || (len(parts) >= 4 && parts[0] == "modules" && parts[2] == "resources")
		if strings.HasSuffix(name, ".bal") {
			if test {
				result.Diagnostics = append(result.Diagnostics, input(name, "Compilation of Ballerina test sources is unsupported."))
			} else if len(parts) != 1 && !(len(parts) == 3 && parts[0] == "modules") && !resource {
				result.Diagnostics = append(result.Diagnostics, input(name, "Unsupported project source layout; expected root sources or modules/<module>/*.bal."))
			}
		}
		if name == "Bala.toml" {
			result.Diagnostics = append(result.Diagnostics, input(name, "Bala project layouts are unsupported; expected one root source package."))
		}
		if path.Base(name) == "Ballerina.toml" && name != "Ballerina.toml" {
			result.Diagnostics = append(result.Diagnostics, input(name, "Nested Ballerina packages are unsupported."))
		}
	}
	if len(result.Diagnostics) > 0 {
		sortDiagnostics(result.Diagnostics)
		return sources, result, nil
	}
	manifest, ok := files["Ballerina.toml"]
	if !ok {
		result.Diagnostics = append(result.Diagnostics, input("Ballerina.toml", "Missing Ballerina.toml for the root package."))
		return sources, result, nil
	}
	toml, parseErr := tomlparser.ReadString(manifest)
	if parseErr != nil {
		result.Diagnostics = append(result.Diagnostics, input("Ballerina.toml", parseErr.Error()))
		return sources, result, nil
	}
	if _, workspace := toml.GetTable("workspace"); workspace {
		result.Diagnostics = append(result.Diagnostics, input("Ballerina.toml", "Workspace project layouts are unsupported; expected one root package."))
		return sources, result, nil
	}

	return sources, result, nil
}

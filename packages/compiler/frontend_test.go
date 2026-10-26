package compiler

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ballerina-nutcracker/ballerina/ast"
)

func exampleFiles(t *testing.T, name string) Files {
	t.Helper()
	files := Files{}
	root := filepath.Join("testdata/upstream/examples", name)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".bal") && !strings.HasSuffix(path, ".toml") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = string(content)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// These integration tests exercise our request-local public-API orchestration,
// which is outside the upstream compiler corpus and must not call Compilation.
func TestResolvedFrontendExamples(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"service-discovery", "automation-flow", "definitions-and-calls", "control-flow", "function-expansion", "source-ranges", "analysis-recovery", "chat-references", "panel-state", "unsupported-constructs", "design-critique", "client-calls"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			files := exampleFiles(t, name)
			before, err := Check(files)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range before.Diagnostics {
				if item.Severity == Error || item.Severity == Fatal || item.Severity == Internal {
					t.Fatalf("fixture exceeds pinned compiler support: %+v", item)
				}
			}
			program, items, err := resolveProgram(files)
			if err != nil {
				t.Fatal(err)
			}
			if program == nil {
				t.Fatalf("local resolution failed: %+v", items)
			}
			workspace := 0
			for _, module := range program.modules {
				if module.workspace {
					workspace++
				}
			}
			if workspace == 0 {
				t.Fatal("missing workspace module")
			}
			if name == "definitions-and-calls" && workspace != 2 {
				t.Fatalf("expected root and math modules, got %d", workspace)
			}
			after, err := Check(files)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("analysis changed Check results: before=%+v after=%+v", before, after)
			}

		})
	}
}

func TestResolvedFrontendStopsBeforeDesugaring(t *testing.T) {
	t.Parallel()
	p, items, err := resolveProgram(project("function step(int i) returns int { return i; } public function main() { int i = 0; while i < 3 { i = step(i + 1); } foreach int n in [1, 2] { i += n; } }"))
	if err != nil || p == nil {
		t.Fatalf("%v: %+v", err, items)
	}
	var body *ast.BLangBlockFunctionBody
	for _, module := range p.modules {
		if module.workspace {
			for _, fn := range module.pkg.Functions {
				if fn.Name.GetValue() == "main" {
					body, _ = fn.Body.(*ast.BLangBlockFunctionBody)
				}
			}
		}
	}
	if body == nil {
		t.Fatal("missing main body")
	}
	if len(body.Stmts) != 3 {
		t.Fatalf("source statements changed: %d", len(body.Stmts))
	}
	loop, ok := body.Stmts[1].(*ast.BLangWhile)
	if !ok {
		t.Fatalf("while lowered to %T", body.Stmts[1])
	}
	if _, ok := body.Stmts[2].(*ast.BLangForeach); !ok {
		t.Fatalf("foreach lowered to %T", body.Stmts[2])
	}
	assignment, ok := loop.Body.Stmts[0].(*ast.BLangAssignment)
	if !ok {
		t.Fatalf("assignment lowered to %T", loop.Body.Stmts[0])
	}
	call, ok := assignment.Expr.(*ast.BLangInvocation)
	if !ok || call.Symbol().IsEmpty() {
		t.Fatal("missing resolved original call")
	}
	for _, module := range p.modules {
		if module.workspace {
			for _, fn := range module.pkg.Functions {
				if fn.Name.GetValue() == "step" && fn.Symbol() != call.Symbol() {
					t.Fatal("call did not resolve to definition symbol")
				}
			}
		}
	}
}

func TestResolvedFrontendNamedModules(t *testing.T) {
	t.Parallel()
	files := project("import browser/http_service.math; public function main() { int value = math:calculate(); int result = value + 1; _ = result; }")
	files["modules/math/calculate.bal"] = "public function calculate() returns int { return 2; }"
	p, items, err := resolveProgram(files)
	if err != nil || p == nil {
		t.Fatalf("%v: %+v", err, items)
	}
	count := 0
	for _, mod := range p.modules {
		if mod.workspace {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("expected two resolved workspace modules, got %d", count)
	}
}

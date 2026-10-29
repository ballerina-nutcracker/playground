package compiler

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

var updateHIRGoldens = flag.Bool("update", false, "explicitly update HIR corpus and test-only parity lookup/synthetic fixtures")

const hirProjectsRoot = "testdata/upstream/tests/fixtures/hir-projects"

type hirCorpusCase struct {
	ID           string            `json:"id"`
	Kind         string            `json:"kind"`
	Directory    string            `json:"directory"`
	InputHash    string            `json:"inputHash"`
	CatalogRef   string            `json:"catalogRef"`
	SourceHashes map[string]string `json:"sourceHashes"`
	AST          *string           `json:"ast"`
	HIR          *string           `json:"hir"`
	Diagnostics  *string           `json:"diagnostics"`
	Reason       string            `json:"reason"`
	Provenance   []struct {
		File string `json:"file"`
	} `json:"provenance"`
}

func readHIRCorpus(t *testing.T) []hirCorpusCase {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(hirProjectsRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Cases []hirCorpusCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Cases) == 0 {
		t.Fatal("empty HIR project corpus")
	}
	return manifest.Cases
}

func readHIRSources(t *testing.T, root string) Files {
	t.Helper()
	files := Files{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".bal") && !strings.HasSuffix(path, ".toml") {
			return fmt.Errorf("unexpected project source file %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestHIRCorpusCoverage(t *testing.T) {
	// Shares the fixture tree with TestHIRProjects' explicit update mode.
	var catalog map[string]struct {
		Kind  string `json:"kind"`
		Files Files  `json:"files"`
	}
	data, err := os.ReadFile("testdata/upstream/tests/fixtures/flow-rendering/inputs/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	ids := map[string]bool{}
	directories := map[string]bool{}
	for _, c := range readHIRCorpus(t) {
		if ids[c.ID] {
			t.Fatalf("duplicate corpus ID %s", c.ID)
		}
		ids[c.ID] = true
		if len(c.Provenance) == 0 {
			t.Fatalf("%s has no provenance", c.ID)
		}
		for _, p := range c.Provenance {
			// Provenance names upstream repo paths; only this package's Go files exist here.
			if !strings.HasPrefix(p.File, "packages/compiler/") || !strings.HasSuffix(p.File, ".go") {
				continue
			}
			if _, err := os.Stat(strings.TrimPrefix(p.File, "packages/compiler/")); err != nil {
				t.Fatalf("%s provenance: %v", c.ID, err)
			}
		}
		if c.CatalogRef != "" {
			input, ok := catalog[c.CatalogRef]
			if !ok || input.Kind != c.Kind || c.InputHash != c.CatalogRef {
				t.Fatalf("%s catalog identity mismatch", c.ID)
			}
			if seen[c.CatalogRef] {
				t.Fatalf("duplicate catalog input %s", c.CatalogRef)
			}
			seen[c.CatalogRef] = true
		}
		if c.Kind == "synthetic" {
			if c.AST != nil || c.HIR != nil || c.Diagnostics != nil || c.Reason == "" {
				t.Fatalf("%s must explicitly omit AST/HIR/diagnostics", c.ID)
			}
			continue
		}
		if c.Kind != "project" || c.Directory != c.ID {
			t.Fatalf("invalid project directory: %+v", c)
		}
		directories[c.Directory] = true
		files := readHIRSources(t, filepath.Join(hirProjectsRoot, c.Directory, "source"))
		if len(files) != len(c.SourceHashes) {
			t.Fatalf("%s source inventory mismatch", c.ID)
		}
		for name, source := range files {
			sum := sha256.Sum256([]byte(source))
			if hex.EncodeToString(sum[:]) != c.SourceHashes[name] {
				t.Fatalf("%s/%s original bytes changed", c.ID, name)
			}
		}
		if c.CatalogRef != "" && !reflect.DeepEqual(files, catalog[c.CatalogRef].Files) {
			t.Fatalf("%s no longer matches captured input bytes", c.ID)
		}
		if (c.AST == nil) != (c.HIR == nil) || (c.HIR != nil && *c.HIR != "hir.golden.json") {
			t.Fatalf("%s must declare HIR exactly when a resolved AST exists", c.ID)
		}
		if c.Diagnostics == nil || *c.Diagnostics != "diagnostics.json" || (c.AST != nil && *c.AST != "ast.golden") {
			t.Fatalf("invalid golden paths: %s", c.ID)
		}
	}
	if len(seen) != len(catalog) {
		t.Fatalf("catalog coverage %d/%d", len(seen), len(catalog))
	}
	entries, err := os.ReadDir(hirProjectsRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() && !directories[entry.Name()] {
			t.Fatalf("unregistered project directory %s", entry.Name())
		}
	}
	examples, err := os.ReadDir("testdata/upstream/examples")
	if err != nil {
		t.Fatal(err)
	}
	for _, example := range examples {
		if !example.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join("testdata/upstream/examples", example.Name(), "Ballerina.toml")); os.IsNotExist(err) {
			continue
		}
		id := "example-" + example.Name()
		if !ids[id] {
			t.Fatalf("example %s lacks AST corpus coverage", example.Name())
		}
		if !reflect.DeepEqual(exampleFiles(t, example.Name()), readHIRSources(t, filepath.Join(hirProjectsRoot, id, "source"))) {
			t.Fatalf("example %s differs from archived original inputs", example.Name())
		}
	}
}

type hirInventoryLiteral struct{ Value, Anchor string }

// Literal ordinals are historical recipes, not live AST positions. Remapping is
// semantic: the decoded value AND its containing input expression must survive.
// Ordered compiler/source-builder calls must also retain their argument ASTs.
func hirInventoryASTProof(t *testing.T, path string, source []byte) (map[string][]hirInventoryLiteral, map[string][]string) {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, source, 0)
	if err != nil {
		t.Fatal(err)
	}
	literals := map[string][]hirInventoryLiteral{}
	calls := map[string][]string{}
	text := func(node ast.Node) string {
		var out bytes.Buffer
		if err := format.Node(&out, fset, node); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	for _, declaration := range file.Decls {
		fn, ok := declaration.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if fn.Name.Name == "project" || fn.Name.Name == "exampleFiles" {
			calls["input helper: "+fn.Name.Name] = []string{text(fn)}
		}
		if !strings.HasPrefix(fn.Name.Name, "Test") {
			continue
		}
		calls[fn.Name.Name] = nil
		inputNames := map[string]bool{}
		addNames := func(node ast.Node) {
			ast.Inspect(node, func(child ast.Node) bool {
				if id, ok := child.(*ast.Ident); ok {
					inputNames[id.Name] = true
				}
				return true
			})
		}
		var stack []ast.Node
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			if node == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			if call, ok := node.(*ast.CallExpr); ok {
				if name, ok := call.Fun.(*ast.Ident); ok {
					switch name.Name {
					case "Analyze", "Check", "resolveProgram", "project", "exampleFiles":
						calls[fn.Name.Name] = append(calls[fn.Name.Name], text(call))
						for _, arg := range call.Args {
							addNames(arg)
						}
					}
				}
			}
			if literal, ok := node.(*ast.BasicLit); ok && literal.Kind == token.STRING {
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				anchor := ""
				for i := len(stack) - 1; i >= 0; i-- {
					if expression, ok := stack[i].(ast.Expr); ok {
						anchor = text(expression)
						break
					}
				}
				literals[fn.Name.Name] = append(literals[fn.Name.Name], hirInventoryLiteral{value, anchor})
			}
			stack = append(stack, node)
			return true
		})
		// Conservatively close over definitions/mutations of every compiler-input
		// variable. This rejects shadowing or retaining an old literal only as dead
		// code while changing the value actually passed to Analyze/Check.
		var bindings []ast.Node
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			switch node.(type) {
			case *ast.AssignStmt, *ast.ValueSpec, *ast.RangeStmt, *ast.IncDecStmt:
				bindings = append(bindings, node)
			}
			return true
		})
		affects := func(node ast.Node) bool {
			found := false
			if node != nil {
				ast.Inspect(node, func(child ast.Node) bool {
					if id, ok := child.(*ast.Ident); ok && inputNames[id.Name] {
						found = true
					}
					return true
				})
			}
			return found
		}
		selected := map[ast.Node]bool{}
		for changed := true; changed; {
			changed = false
			for _, node := range bindings {
				if selected[node] {
					continue
				}
				var target ast.Node
				switch binding := node.(type) {
				case *ast.AssignStmt:
					for _, left := range binding.Lhs {
						if affects(left) {
							target = left
						}
					}
					if target != nil {
						for _, right := range binding.Rhs {
							addNames(right)
						}
					}
				case *ast.ValueSpec:
					for _, name := range binding.Names {
						if affects(name) {
							target = name
						}
					}
					if target != nil {
						for _, right := range binding.Values {
							addNames(right)
						}
					}
				case *ast.RangeStmt:
					if affects(binding.Key) || affects(binding.Value) {
						target = binding.X
						addNames(binding.X)
					}
				case *ast.IncDecStmt:
					if affects(binding.X) {
						target = binding.X
					}
				}
				if target != nil {
					selected[node] = true
					changed = true
				}
			}
		}
		for _, node := range bindings {
			if !selected[node] {
				continue
			}
			if loop, ok := node.(*ast.RangeStmt); ok {
				calls[fn.Name.Name] = append(calls[fn.Name.Name], "input range: "+text(loop.X))
			} else {
				calls[fn.Name.Name] = append(calls[fn.Name.Name], "input binding: "+text(node))
			}
		}
	}
	return literals, calls
}

func TestHIRMigrationASTProof(t *testing.T) {
	original := `package compiler
func TestScenario() { source := "public function main() {}"; Analyze(project(source)); Check(project(source)) }
`
	oldLiterals, oldCalls := hirInventoryASTProof(t, "original.go", []byte(original))
	reorderedAssertions := strings.Replace(original, `source :=`, `assert("new assertion"); source :=`, 1)
	liveLiterals, liveCalls := hirInventoryASTProof(t, "current.go", []byte(reorderedAssertions))
	if !reflect.DeepEqual(oldCalls, liveCalls) || oldLiterals["TestScenario"][0] != liveLiterals["TestScenario"][1] {
		t.Fatal("assertion-only migration failed semantic literal remapping")
	}
	for name, source := range map[string]string{
		"Ballerina literal": strings.Replace(original, "function main() {}", "function changed() {}", 1),
		"removed scenario":  strings.Replace(original, "TestScenario", "RemovedScenario", 1),
		"retained dead literal but changed actual input": strings.Replace(original, `Analyze(project(source))`, `source = "public function changed() {}"; Analyze(project(source))`, 1),
		"request order": strings.Replace(original, "Analyze(project(source)); Check(project(source))", "Check(project(source)); Analyze(project(source))", 1),
	} {
		t.Run(name, func(t *testing.T) {
			_, changed := hirInventoryASTProof(t, "changed.go", []byte(source))
			if reflect.DeepEqual(oldCalls, changed) {
				t.Fatal("current input mutation escaped AST proof")
			}
		})
	}
}

// TestHIRSourceInventory is deliberately independent of the frozen render catalog.
// Original AST recipes reconstruct requests independently of captured render
// inputs; semantic anchors remap their literals into the live test AST, while
// compiler-call and input-binding projections prove their continued use.
func TestHIRSourceInventory(t *testing.T) {
	t.Skip("upstream-repo bookkeeping: needs node, Playwright and upstream browser specs (see NOTICE)")
	data, err := os.ReadFile(filepath.Join(hirProjectsRoot, "source-inventory.json"))
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		Native []struct {
			File      string `json:"file"`
			SHA256    string `json:"sha256"`
			Scenarios []struct {
				Name      string `json:"name"`
				Exclusion string `json:"exclusion"`
				Requests  []struct {
					Project        string           `json:"project"`
					Example        string           `json:"example"`
					Literals       map[string][]int `json:"literals"`
					ManifestPrefix []string         `json:"manifestPrefix"`
				} `json:"requests"`
			} `json:"scenarios"`
		} `json:"native"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	// The shared verifier validates both original archive and exact current hashes;
	// Go then independently proves the live AST still supplies every recipe.
	proof, err := exec.Command("node", "testdata/upstream/scripts/check_hir_migrations.mjs").CombinedOutput()
	if err != nil {
		t.Fatalf("migration registry: %v\n%s", err, proof)
	}
	migrationData, err := os.ReadFile("testdata/upstream/tests/hir-baseline-migrations.json")
	if err != nil {
		t.Fatal(err)
	}
	var migrations struct {
		Files []struct {
			File, Archive string
			Extraction    struct{ AdditionalScenarios []string }
		}
	}
	if err := json.Unmarshal(migrationData, &migrations); err != nil {
		t.Fatal(err)
	}
	archives := map[string]string{}
	additions := map[string][]string{}
	for _, migration := range migrations.Files {
		archives[migration.File] = migration.Archive
		additions[migration.File] = migration.Extraction.AdditionalScenarios
	}
	registered := map[string]bool{}
	for _, entry := range inventory.Native {
		path := filepath.Join("testdata/upstream", entry.File)
		if registered[path] {
			t.Fatalf("duplicate inventory file %s", path)
		}
		registered[path] = true
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		currentSource := source
		if archive := archives[entry.File]; archive != "" {
			source, err = os.ReadFile(filepath.Join("testdata/upstream", archive))
			if err != nil {
				t.Fatal(err)
			}
		}
		sum := sha256.Sum256(source)
		if hex.EncodeToString(sum[:]) != entry.SHA256 {
			t.Fatalf("original test changed: %s; explicitly audit source inventory, never silently refresh its hash", path)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, source, 0)
		if err != nil {
			t.Fatal(err)
		}
		liveLiterals, liveCalls := hirInventoryASTProof(t, path, currentSource)
		originalLiterals, originalCalls := hirInventoryASTProof(t, path, source)
		for name, calls := range originalCalls {
			live, exists := liveCalls[name]
			if !exists || !reflect.DeepEqual(live, calls) {
				t.Fatalf("current compiler input expressions/order or scenario changed: %s/%s", path, name)
			}
			delete(liveCalls, name)
		}
		for _, name := range additions[entry.File] {
			calls, exists := liveCalls[name]
			if !exists || len(calls) != 0 {
				t.Fatalf("new scenario must be explicit non-compiling HIR-only coverage: %s/%s", path, name)
			}
			delete(liveCalls, name)
		}
		if len(liveCalls) != 0 {
			t.Fatalf("uninventoried current native scenarios: %s: %v", path, liveCalls)
		}
		functions := map[string][]string{}
		for _, declaration := range parsed.Decls {
			fn, ok := declaration.(*ast.FuncDecl)
			if !ok || !strings.HasPrefix(fn.Name.Name, "Test") {
				continue
			}
			literals := []string{}
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				if literal, ok := node.(*ast.BasicLit); ok && literal.Kind == token.STRING {
					value, err := strconv.Unquote(literal.Value)
					if err != nil {
						t.Fatal(err)
					}
					literals = append(literals, value)
				}
				return true
			})
			functions[fn.Name.Name] = literals
		}
		for _, scenario := range entry.Scenarios {
			literals, ok := functions[scenario.Name]
			if !ok {
				t.Fatalf("unknown/duplicate scenario %s/%s", path, scenario.Name)
			}
			delete(functions, scenario.Name)
			if len(scenario.Requests) == 0 && scenario.Exclusion == "" {
				t.Fatalf("unclassified scenario %s", scenario.Name)
			}
			for _, request := range scenario.Requests {
				files := project("")
				if request.Example != "" {
					files = exampleFiles(t, request.Example)
				}
				for name, indices := range request.Literals {
					var source strings.Builder
					for _, index := range indices {
						if index < 0 || index >= len(literals) {
							t.Fatalf("bad literal index %s/%d", scenario.Name, index)
						}
						original := originalLiterals[scenario.Name][index]
						matches := 0
						for _, live := range liveLiterals[scenario.Name] {
							if live == original {
								matches++
							}
						}
						if matches == 0 {
							t.Fatalf("current input literal/expression missing: %s/%s/%d", path, scenario.Name, index)
						}
						// Anchor equality proves this is an input expression, not a
						// matching string moved into an assertion or dead standalone literal.
						source.WriteString(original.Value)
					}
					files[name] = source.String()
				}
				for _, name := range request.ManifestPrefix {
					files[name] = manifest + files[name]
				}
				archived := readHIRSources(t, filepath.Join(hirProjectsRoot, request.Project, "source"))
				if !reflect.DeepEqual(files, archived) {
					t.Fatalf("%s/%s request %s differs from current original source definitions", path, scenario.Name, request.Project)
				}
			}
		}
		if len(functions) != 0 {
			t.Fatalf("uninventoried native scenarios in %s: %v", path, functions)
		}
	}
	paths, err := filepath.Glob("*_test.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if strings.HasPrefix(path, "hir") {
			continue
		} // HIR's own contract tests are not the pre-HIR source baseline.
		if !registered[filepath.Join("testdata/upstream", path)] {
			t.Fatalf("uninventoried native test file %s", path)
		}
	}
	// Babel performs static browser request extraction, never eval.
	output, err := exec.Command("node", "testdata/upstream/scripts/update_hir_goldens.mjs", "--check-inventory").CombinedOutput()
	if err != nil {
		t.Fatalf("browser source inventory: %v\n%s", err, output)
	}
}

func TestHIRProjects(t *testing.T) {
	// Explicit updates write shared fixture files, so this suite is not parallel.
	for _, c := range readHIRCorpus(t) {
		if c.Kind == "project" {
			t.Run(c.ID, func(t *testing.T) { runHIRCase(t, c.Directory, *updateHIRGoldens) })
		}
	}
}

// runHIRCase resolves once and compares the actual frontend before any lowering.
// Invalid and synthetic inputs never acquire fabricated HIR.
func runHIRCase(t *testing.T, directory string, update bool) {
	t.Helper()
	if filepath.Base(directory) != directory || directory == "." || directory == ".." {
		t.Fatal("unsafe corpus directory")
	}
	root := filepath.Join(hirProjectsRoot, directory)
	files := readHIRSources(t, filepath.Join(root, "source"))
	program, items, err := resolveProgram(files)
	if err != nil {
		t.Fatalf("frontend infrastructure error: %v", err)
	}
	if items == nil {
		items = []Diagnostic{}
	}
	diagnostics, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	compareHIRGolden(t, root, "diagnostics.json", append(diagnostics, '\n'), update)
	invalid := false
	for _, item := range items {
		if item.Severity == Error || item.Severity == Fatal || item.Severity == Internal {
			invalid = true
		}
	}
	if invalid {
		if program != nil {
			t.Fatal("invalid source returned a resolved program")
		}
		if _, err := os.Stat(filepath.Join(root, "ast.golden")); !os.IsNotExist(err) {
			t.Fatal("invalid input must not have an AST golden (remove stale golden explicitly)")
		}
		if _, err := os.Stat(filepath.Join(root, "hir.golden.json")); !os.IsNotExist(err) {
			t.Fatal("invalid input must not have a HIR golden (remove stale golden explicitly)")
		}
		if !update {
			for _, c := range readHIRCorpus(t) {
				if c.Directory == directory && (c.AST != nil || c.HIR != nil) {
					t.Fatal("invalid fixture must explicitly declare ast: null and hir: null")
				}
			}
		}
		return
	}
	if program == nil {
		t.Fatal("frontend returned neither a program nor source errors")
	}
	if !update {
		for _, c := range readHIRCorpus(t) {
			if c.Directory == directory && c.AST == nil {
				t.Fatal("valid fixture must declare its AST expectation")
			}
		}
	}
	frontend, err := printFrontend(program)
	if err != nil {
		t.Fatal(err)
	}
	compareHIRGolden(t, root, "ast.golden", []byte(frontend), update)
	calls := hirCloneArgumentMap(program.sourceCallArgs)
	news := hirCloneArgumentMap(program.sourceNewArgs)
	sourceSnapshot := Files{}
	for name, source := range program.files {
		sourceSnapshot[name] = source
	}
	hir, err := lowerProgram(program)
	if err != nil {
		t.Fatalf("lower resolved frontend: %v", err)
	}
	printed := checkLoweredHIR(t, files, hir)
	compareHIRGolden(t, root, "hir.golden.json", []byte(printed), update)
	// Test-only lookup key for the HIR parity Vite alias. Extract independently:
	// legacy extraction must never supply input to direct HIR lowering.
	legacyResolved, _, legacyErr := resolveProgram(files)
	if legacyErr != nil || legacyResolved == nil {
		t.Fatalf("resolve test-only legacy lookup: %v", legacyErr)
	}
	legacy, legacyErr := extractProgram(legacyResolved)
	if legacyErr != nil {
		t.Fatal(legacyErr)
	}
	legacyJSON, legacyErr := json.MarshalIndent(legacy, "", "  ")
	if legacyErr != nil {
		t.Fatal(legacyErr)
	}
	compareHIRGolden(t, root, "legacy-model.json", append(legacyJSON, '\n'), update)
	second, err := lowerProgram(program)
	if err != nil {
		t.Fatalf("repeat lowering: %v", err)
	}
	if again := checkLoweredHIR(t, files, second); again != printed {
		t.Fatal("repeated lowering changed HIR")
	}
	again, err := printFrontend(program)
	if err != nil || again != frontend {
		t.Fatalf("lowering mutated frontend dump: %v", err)
	}
	if !reflect.DeepEqual(calls, program.sourceCallArgs) || !reflect.DeepEqual(news, program.sourceNewArgs) || !reflect.DeepEqual(sourceSnapshot, program.files) {
		t.Fatal("lowering mutated source/provenance snapshots")
	}
}

func TestHIRFrontendInputOrder(t *testing.T) {
	t.Parallel()
	for _, directory := range []string{"example-definitions-and-calls", "example-source-ranges", "targeted-provenance"} {
		t.Run(directory, func(t *testing.T) {
			files := readHIRSources(t, filepath.Join(hirProjectsRoot, directory, "source"))
			names := make([]string, 0, len(files))
			for name := range files {
				names = append(names, name)
			}
			sort.Sort(sort.Reverse(sort.StringSlice(names)))
			reordered := Files{}
			for _, name := range names {
				reordered[name] = files[name]
			}
			first, items, err := resolveProgram(files)
			if err != nil || first == nil {
				t.Fatalf("%v: %+v", err, items)
			}
			second, items, err := resolveProgram(reordered)
			if err != nil || second == nil {
				t.Fatalf("%v: %+v", err, items)
			}
			a, err := printFrontend(first)
			if err != nil {
				t.Fatal(err)
			}
			b, err := printFrontend(second)
			if err != nil {
				t.Fatal(err)
			}
			if a != b {
				t.Fatal("reordered project input changed frontend dump")
			}
			left, err := lowerProgram(first)
			if err != nil {
				t.Fatal(err)
			}
			right, err := lowerProgram(second)
			if err != nil {
				t.Fatal(err)
			}
			if checkLoweredHIR(t, files, left) != checkLoweredHIR(t, reordered, right) {
				t.Fatal("reordered project input changed complete HIR")
			}
		})
	}
}

func hirCloneArgumentMap[K comparable, V any](original map[K][]V) map[K][]V {
	if original == nil {
		return nil
	}
	clone := make(map[K][]V, len(original))
	for key, arguments := range original {
		if arguments == nil {
			clone[key] = nil
		} else {
			clone[key] = append(make([]V, 0, len(arguments)), arguments...)
		}
	}
	return clone
}

// checkLoweredHIR checks source attribution against captured bytes, independently
// of the lowering source-index builder and the JSON validator.
func checkLoweredHIR(t *testing.T, files Files, program HIRProgram) string {
	t.Helper()
	if err := ValidateHIR(program); err != nil {
		t.Fatalf("invalid lowered HIR: %v", err)
	}
	for key, located := range program.Sources {
		if key != located.ID {
			t.Fatalf("source index key %q differs from located ID %q", key, located.ID)
		}
		source, ok := files[located.Source.File]
		if !ok {
			t.Fatalf("source %s refers to uncaptured file %q", key, located.Source.File)
		}
		start := hirSourceOffset(t, source, located.Source.Range.Start)
		end := hirSourceOffset(t, source, located.Source.Range.End)
		if start > end || source[start:end] != located.Text {
			t.Fatalf("source %s text is not the exact Unicode/CRLF captured range: %+v", key, located.Source)
		}
	}
	printed, err := PrintHIR(program)
	if err != nil {
		t.Fatal(err)
	}
	var decoded HIRProgram
	if err := json.Unmarshal([]byte(printed), &decoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateHIR(decoded); err != nil {
		t.Fatalf("round-tripped HIR: %v", err)
	}
	again, err := PrintHIR(decoded)
	if err != nil || printed != again {
		t.Fatalf("HIR round-trip changed complete JSON: %v", err)
	}
	return printed
}

func hirSourceOffset(t *testing.T, source string, position Position) int {
	t.Helper()
	if position.Line < 1 || position.Column < 1 || !utf8.ValidString(source) {
		t.Fatalf("invalid captured source position %+v", position)
	}
	offset := 0
	for line := 1; line < position.Line; line++ {
		next := strings.IndexAny(source[offset:], "\r\n")
		if next < 0 {
			t.Fatalf("line outside captured source: %+v", position)
		}
		offset += next
		if source[offset] == '\r' && offset+1 < len(source) && source[offset+1] == '\n' {
			offset++
		}
		offset++
	}
	for column := 1; column < position.Column; column++ {
		if offset >= len(source) || source[offset] == '\r' || source[offset] == '\n' {
			t.Fatalf("column outside captured source: %+v", position)
		}
		_, size := utf8.DecodeRuneInString(source[offset:])
		offset += size
	}
	return offset
}

// TestHIRLegacySourceIndexParity compares only the legacy location contract, not
// statement semantics. Reflection includes embedded locations and locations in
// non-display fields (client receivers, initializers, arguments and evaluations).
func TestHIRLegacySourceIndexParity(t *testing.T) {
	for _, c := range readHIRCorpus(t) {
		if c.Kind != "project" || c.AST == nil {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			files := readHIRSources(t, filepath.Join(hirProjectsRoot, c.Directory, "source"))
			checkHIRLegacySourceIndexParity(t, files)
		})
	}
	// Keep multibyte code points and CRLF together: byte columns or normalized
	// newlines must not accidentally satisfy the source identity contract.
	t.Run("targeted-provenance-CRLF", func(t *testing.T) {
		files := readHIRSources(t, filepath.Join(hirProjectsRoot, "targeted-provenance", "source"))
		for name, source := range files {
			if strings.HasSuffix(name, ".bal") {
				files[name] = strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\n", "\r\n")
			}
		}
		checkHIRLegacySourceIndexParity(t, files)
	})
}

func checkHIRLegacySourceIndexParity(t *testing.T, files Files) {
	t.Helper()
	program, items, err := resolveProgram(files)
	if err != nil || program == nil {
		t.Fatalf("resolve direct input: %v; diagnostics: %+v", err, items)
	}
	direct, err := lowerProgram(program)
	if err != nil {
		t.Fatal(err)
	}
	checkLoweredHIR(t, files, direct)
	// Legacy extraction mutates resolved-program metadata. Do not let it seed
	// metadata for direct lowering (or vice versa).
	legacyProgram, items, err := resolveProgram(files)
	if err != nil || legacyProgram == nil {
		t.Fatalf("resolve legacy input: %v; diagnostics: %+v", err, items)
	}
	legacy, err := extractProgram(legacyProgram)
	if err != nil {
		t.Fatal(err)
	}
	var visit func(reflect.Value, string)
	visit = func(value reflect.Value, path string) {
		if value.Kind() == reflect.Pointer || value.Kind() == reflect.Interface {
			if !value.IsNil() {
				visit(value.Elem(), path)
			}
			return
		}
		if value.Type() == reflect.TypeOf(LocatedModel{}) {
			old := value.Interface().(LocatedModel)
			actual, ok := direct.Sources[old.ID]
			if !ok {
				var alternateIDs []string
				for id, candidate := range direct.Sources {
					if candidate.Source == old.Source && candidate.Text == old.Text {
						alternateIDs = append(alternateIDs, id)
					}
				}
				sort.Strings(alternateIDs)
				t.Errorf("%s: legacy source ID %q missing from direct HIR (legacy: %+v); same source/text under IDs: %v", path, old.ID, old, alternateIDs)
				return
			}
			if actual != old {
				t.Errorf("%s: legacy source ID %q identity mismatch\nlegacy: %+v\ndirect: %+v", path, old.ID, old, actual)
			}
			source, ok := files[old.Source.File]
			if !ok {
				t.Fatalf("%s: unknown legacy source file %q", path, old.Source.File)
			}
			start := hirSourceOffset(t, source, old.Source.Range.Start)
			end := hirSourceOffset(t, source, old.Source.Range.End)
			if start > end || source[start:end] != old.Text {
				t.Errorf("%s: legacy source ID %q is not the exact Unicode/CRLF range", path, old.ID)
			}
			return
		}
		switch value.Kind() {
		case reflect.Struct:
			for i := 0; i < value.NumField(); i++ {
				visit(value.Field(i), path+"."+value.Type().Field(i).Name)
			}
		case reflect.Map:
			for _, key := range value.MapKeys() {
				visit(value.MapIndex(key), fmt.Sprintf("%s[%v]", path, key.Interface()))
			}
		case reflect.Slice, reflect.Array:
			for i := 0; i < value.Len(); i++ {
				visit(value.Index(i), fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
	visit(reflect.ValueOf(legacy), "legacy")
}

func compareHIRGolden(t *testing.T, root, name string, actual []byte, update bool) {
	t.Helper()
	// Hard allow-list: even explicit update can never write render SVG/HTML files.
	if name != "ast.golden" && name != "diagnostics.json" && name != "hir.golden.json" && name != "legacy-model.json" {
		t.Fatalf("not an allowed HIR corpus or test-only lookup golden: %s", name)
	}
	path := filepath.Join(root, name)
	if update {
		if err := os.WriteFile(path, actual, 0644); err != nil {
			t.Fatal(err)
		}
		return
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v; update explicitly with npm run test:hir:update", path, err)
	}
	if bytes.Equal(expected, actual) {
		return
	}
	temporary := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(temporary, actual, 0600); err != nil {
		t.Fatal(err)
	}
	diff, _ := exec.Command("diff", "-u", path, temporary).CombinedOutput()
	if len(diff) == 0 {
		diff = []byte(fmt.Sprintf("expected %d bytes; actual %d bytes", len(expected), len(actual)))
	}
	t.Fatalf("%s differs (npm run test:hir:update to accept intentionally):\n%s", path, diff)
}

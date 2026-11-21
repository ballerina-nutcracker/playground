package compiler

import (
	"encoding/json"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
	"github.com/ballerina-nutcracker/ballerina/tools/text"
	"io/fs"
	"reflect"
	"strings"
	"testing"
)

const manifest = "[package]\norg = \"browser\"\nname = \"http_service\"\nversion = \"0.1.0\"\n"

func project(source string) Files { return Files{"Ballerina.toml": manifest, "main.bal": source} }
func TestProjects(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		valid        bool
	}{
		{"starter", "import ballerina/http;\nservice / on new http:Listener(8080) {}", true},
		{"syntax", "public function main( {", false},
		{"type", "public function main() { int x = \"bad\"; }", false},
		{"control flow", "function value() returns int { }", false},
		{"unresolved import", "import missing/package;", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := project(tc.source)
			before := project(tc.source)
			result, err := Check(files)
			if err != nil {
				t.Fatal(err)
			}
			if (len(result.Diagnostics) == 0) != tc.valid {
				t.Fatalf("diagnostics: %+v", result.Diagnostics)
			}
			if !reflect.DeepEqual(files, before) {
				t.Fatal("input changed")
			}
			for _, d := range result.Diagnostics {
				if d.File == "main.bal" && d.Range == nil {
					t.Fatalf("source range missing: %+v", d)
				}
			}
			b, _ := json.Marshal(result)
			if tc.valid && string(b) != "{\"diagnostics\":[]}" {
				t.Fatal(string(b))
			}
		})
	}
}
func TestProjectInput(t *testing.T) {
	for _, files := range []Files{nil, {}, {"main.bal": ""}, {"Ballerina.toml": "[package"}, {"Ballerina.toml": "[workspace]\npackages=[]"}, {"Ballerina.toml": manifest, "nested/main.bal": ""}, {"Ballerina.toml": manifest, "child/Ballerina.toml": manifest}} {
		r, err := Check(files)
		if err != nil || len(r.Diagnostics) == 0 {
			t.Fatalf("%v: %+v %v", files, r, err)
		}
	}
	for _, name := range []string{"tests/test.bal", "tests/nested/test.bal", "modules/foo/tests/test.bal", "modules/foo/tests/nested/test.bal"} {
		for _, source := range []string{"function broken( {", "function test() { int x = \"bad\"; }"} {
			files := project("")
			files[name] = source
			r, err := Check(files)
			if err != nil || len(r.Diagnostics) != 1 {
				t.Fatalf("%+v %v", r, err)
			}
			d := r.Diagnostics[0]
			if d.File != name || d.Range != nil || !strings.Contains(d.Message, "test sources is unsupported") {
				t.Fatalf("%+v", d)
			}
		}
	}
}
func TestPaths(t *testing.T) {
	for _, name := range []string{"", ".", "../main.bal", "/main.bal", "a//b", "a/./b", "a\\b", "a\x00b", "C:/a"} {
		if _, err := sourceFS(Files{name: ""}); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if _, err := sourceFS(Files{"a": "", "a/b": ""}); err == nil {
		t.Fatal("conflict accepted")
	}
}
func TestPosition(t *testing.T) {
	source := "a😀é\r\nb\n"
	for _, tc := range []struct{ offset, line, column int }{{0, 1, 1}, {1, 1, 2}, {5, 1, 3}, {7, 1, 4}, {8, 2, 1}, {9, 2, 1}, {10, 2, 2}, {11, 3, 1}} {
		p, err := position(source, tc.offset)
		if err != nil || p != (Position{tc.line, tc.column}) {
			t.Fatalf("%+v: %+v %v", tc, p, err)
		}
	}
	for _, offset := range []int{-1, 2, 3, 4, 6, 12} {
		if _, err := position(source, offset); err == nil {
			t.Fatal(offset)
		}
	}
}
func TestModulesAndFreshState(t *testing.T) {
	files := project("public int a = 1;")
	files["second.bal"] = "public int b = a;"
	files["modules/one/main.bal"] = "int x = \"bad\";"
	files["modules/two/main.bal"] = "int y = \"bad\";"
	r, err := Check(files)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, d := range r.Diagnostics {
		found[d.File] = true
	}
	if !found["modules/one/main.bal"] || !found["modules/two/main.bal"] {
		t.Fatalf("%+v", r)
	}
	for range 2 {
		next, err := Check(files)
		if err != nil || !reflect.DeepEqual(r, next) {
			t.Fatalf("unstable: %+v %v", next, err)
		}
	}
	delete(files, "modules/one/main.bal")
	delete(files, "modules/two/main.bal")
	r, err = Check(files)
	if err != nil || len(r.Diagnostics) != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	files["main.bal"] = "int a = \"bad\";"
	r, err = Check(files)
	if err != nil || len(r.Diagnostics) == 0 {
		t.Fatalf("%+v %v", r, err)
	}
}
func TestNormalize(t *testing.T) {
	env := diagnostics.NewDiagnosticEnv()
	env.RegisterFile("main.bal", text.TextDocumentFromText("😀\r\nx"))
	sources, _ := sourceFS(Files{"main.bal": "😀\r\nx"})
	var items []diagnostics.Diagnostic
	for _, severity := range []diagnostics.DiagnosticSeverity{diagnostics.Internal, diagnostics.Hint, diagnostics.Info, diagnostics.Warning, diagnostics.Error, diagnostics.Fatal} {
		code := "CODE"
		info := diagnostics.NewDiagnosticInfo(&code, "message", severity)
		items = append(items, diagnostics.CreateDiagnostic(info, diagnostics.NewLocation(env, "main.bal", 4, 4)))
	}
	items = append(items, diagnostics.CreateDiagnostic(diagnostics.NewDiagnosticInfo(nil, "manifest", diagnostics.Error), diagnostics.NewBallerinaTomlLocation(100, 101)))
	items = append(items, diagnostics.CreateDiagnostic(diagnostics.NewDiagnosticInfo(nil, "unknown", diagnostics.Warning), diagnostics.Location{}))
	r, err := normalizeDiagnostics(items, env, sources)
	if err != nil {
		t.Fatal(err)
	}
	if len(r) != 8 || r[0].File != "" || r[0].Range != nil || r[1].File != "Ballerina.toml" || r[1].Range != nil {
		t.Fatalf("%+v", r)
	}
	for _, d := range r[2:] {
		if d.Code != "CODE" || d.Range.Start != (Position{1, 2}) || d.Range.Start != d.Range.End {
			t.Fatalf("%+v", d)
		}
	}
	bad := diagnostics.CreateDiagnostic(diagnostics.NewDiagnosticInfo(nil, "bad", diagnostics.Error), diagnostics.NewLocation(env, "main.bal", 1, 2))
	if _, err := normalizeDiagnostics([]diagnostics.Diagnostic{bad}, env, sources); err == nil {
		t.Fatal("accepted bad offsets")
	}
}

func TestManifestAndDependencyDiagnostics(t *testing.T) {
	for _, content := range []string{manifest + "readme = \"missing.md\"\n", "[package]\norg=\"browser\"\nname=\"http_service\"\nversion=\"wrong\"\n"} {
		files := project("")
		files["Ballerina.toml"] = content
		r, err := Check(files)
		if err != nil || len(r.Diagnostics) == 0 {
			t.Fatalf("%+v %v", r, err)
		}
		for _, d := range r.Diagnostics {
			if d.File == "Ballerina.toml" && d.Range != nil {
				t.Fatalf("fabricated manifest range: %+v", d)
			}
		}
	}
	files := project("import absent/dependency;\n")
	files["resources/data.bal"] = "not a source"
	files["modules/sample/resources/data.bal"] = "not a source"
	r, err := Check(files)
	if err != nil || len(r.Diagnostics) == 0 {
		t.Fatalf("%+v %v", r, err)
	}
	for _, d := range r.Diagnostics {
		if strings.Contains(d.File, "resources") {
			t.Fatalf("resource compiled: %+v", d)
		}
	}
}

func TestUnicodeSourceRange(t *testing.T) {
	source := "public string label = \"😀\"; public int value = \"bad\";\r\n"
	r, err := Check(project(source))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Diagnostics) == 0 {
		t.Fatal("missing type error")
	}
	for _, d := range r.Diagnostics {
		if d.File != "main.bal" || d.Range == nil {
			t.Fatalf("%+v", d)
		}
		if strings.Contains(d.Message, "incompatible types") {
			start := strings.Index(source, "\"bad\"")
			expected, _ := position(source, start)
			if d.Range.Start != expected {
				t.Fatalf("got %+v want %+v", d.Range, expected)
			}
		}
	}
}
func TestDependencySourceIdentity(t *testing.T) {
	sources, err := diagnosticSources(Files{})
	if err != nil {
		t.Fatal(err)
	}
	env := diagnostics.NewDiagnosticEnv()
	key := "ballerina/http/0.0.1::http.bal"
	// Use an actual embedded document rather than a workspace basename alias.
	content, err := fs.ReadFile(sources, key)
	if err != nil {
		t.Fatal(err)
	}
	env.RegisterFile(key, text.TextDocumentFromText(string(content)))
	d := diagnostics.CreateDiagnostic(diagnostics.NewDiagnosticInfo(nil, "dependency diagnostic", diagnostics.Error), diagnostics.NewLocation(env, key, 0, 0))
	result, err := normalizeDiagnostics([]diagnostics.Diagnostic{d}, env, sources)
	if err != nil || len(result) != 1 || result[0].File != key || result[0].Range == nil {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestResourcesAreNotSource(t *testing.T) {
	files := project("")
	files["resources/data.bal"] = "not a source"
	files["modules/sample/main.bal"] = "public int x=1;"
	files["modules/sample/resources/data.bal"] = "not a source"
	result, err := Check(files)
	if err != nil || len(result.Diagnostics) != 0 {
		t.Fatalf("%+v %v", result, err)
	}
}
func TestReadOnlySourceFS(t *testing.T) {
	files := Files{"modules/sample/main.bal": "original"}
	source, err := sourceFS(files)
	if err != nil {
		t.Fatal(err)
	}
	file, err := source.Open("modules/sample/main.bal")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, ok := file.(interface{ Write([]byte) (int, error) }); ok {
		t.Fatal("source handle exposes writes")
	}
	files["modules/sample/main.bal"] = "changed"
	content, err := fs.ReadFile(source, "modules/sample/main.bal")
	if err != nil || string(content) != "original" {
		t.Fatalf("%q %v", content, err)
	}
	if _, err := source.Open("../outside"); err == nil {
		t.Fatal("path escaped source FS")
	}
}

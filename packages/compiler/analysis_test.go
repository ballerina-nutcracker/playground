package compiler

import (
	"encoding/json"
	"strings"
	"testing"
)

// The adapter's exported model and stop point are not upstream compiler behavior.
func hirTestReferences(graph HIRGraph) []HIRReferenceBody {
	var calls []HIRReferenceBody
	for _, node := range graph.Nodes {
		if body, ok := node.Body.Value.(HIRReferenceBody); ok {
			calls = append(calls, body)
		}
	}
	return calls
}

func hirTestSource(t *testing.T, program *HIRProgram, graph HIRGraph, text string) LocatedModel {
	t.Helper()
	for _, source := range program.Sources {
		if source.Text == text && source.Source.File == graph.Source.File && source.Source.Range.Start.Line >= graph.Source.Range.Start.Line && source.Source.Range.End.Line <= graph.Source.Range.End.Line {
			return source
		}
	}
	t.Fatalf("missing HIR source %q in %s", text, graph.ID)
	return LocatedModel{}
}

func hirTestLabels(graph HIRGraph) string {
	var labels []string
	for _, node := range graph.Nodes {
		switch p := node.Presentation.Value.(type) {
		case HIRPlainPresentation:
			labels = append(labels, string(p.Label))
		case HIRClientPresentation:
			labels = append(labels, string(p.Label))
		}
	}
	return strings.Join(labels, "\n")
}

// Source association failures are adapter publication invariants, not compiler diagnostics.
func TestHIRCapturedSourceValidation(t *testing.T) {
	t.Parallel()
	text := "a🚀 café\r\nnext\rfinal\n"
	located := LocatedModel{ID: "source", Source: SourceReferenceModel{File: "captured.bal", Range: SourceRange{Start: Position{1, 2}, End: Position{2, 3}}}, Text: "🚀 café\r\nne"}
	for _, tc := range []struct {
		name   string
		change func(*LocatedModel)
		valid  bool
	}{
		{"Unicode CRLF exclusive end", func(*LocatedModel) {}, true},
		{"missing file", func(s *LocatedModel) { s.Source.File = "missing.bal" }, false},
		{"wrong text", func(s *LocatedModel) { s.Text += "x" }, false},
		{"zero line", func(s *LocatedModel) { s.Source.Range.Start.Line = 0 }, false},
		{"zero column", func(s *LocatedModel) { s.Source.Range.Start.Column = 0 }, false},
		{"line outside file", func(s *LocatedModel) { s.Source.Range.End.Line = 6 }, false},
		{"column past newline", func(s *LocatedModel) { s.Source.Range.Start.Column = 9 }, false},
		{"reversed", func(s *LocatedModel) { s.Source.Range.End = Position{1, 1} }, false},
		{"exclusive end", func(s *LocatedModel) { s.Source.Range.End.Column++ }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			source := located
			tc.change(&source)
			program := HIRProgram{Sources: HIRRecord[LocatedModel]{source.ID: source}}
			err := validateHIRSources(program, Files{"captured.bal": text})
			if (err == nil) != tc.valid {
				t.Fatalf("source validation: %v", err)
			}
		})
	}
	for _, tc := range []struct {
		position Position
		offset   int
	}{
		{Position{1, 1}, 0}, {Position{1, 3}, len("a🚀")},
		{Position{2, 1}, len("a🚀 café\r\n")},
		{Position{3, 1}, len("a🚀 café\r\nnext\r")},
		{Position{4, 1}, len(text)},
	} {
		offset, err := sourcePositionOffset(text, tc.position)
		if err != nil || offset != tc.offset {
			t.Fatalf("%+v: %d %v", tc.position, offset, err)
		}
		position, err := position(text, offset)
		if err != nil || position != tc.position {
			t.Fatalf("round trip: %+v %v", position, err)
		}
	}
	if _, err := sourcePositionOffset("\xff", Position{1, 1}); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}

func TestAnalyzeExamples(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"service-discovery", "automation-flow", "definitions-and-calls", "control-flow", "function-expansion", "source-ranges", "analysis-recovery", "chat-references", "panel-state", "unsupported-constructs", "design-critique", "client-calls"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			result, err := Analyze(exampleFiles(t, name))
			if err != nil {
				t.Fatal(err)
			}
			if result.Kind != "valid" {
				t.Fatalf("%+v", result.Diagnostics)
			}
			if len(result.Program.Scopes) == 0 {
				t.Fatal("missing scopes")
			}
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(data), `"body":null`) {
				t.Fatal("null body")
			}
			if name == "service-discovery" {
				if len(result.Program.Scopes) != 3 {
					t.Fatalf("services: %+v", result.Program.Scopes)
				}
				remoteTitles := []string{}
				for _, scope := range result.Program.Scopes {
					for _, endpoint := range *scope.Endpoints {
						if endpoint.Kind == "remote" {
							remoteTitles = append(remoteTitles, endpoint.Title)
						}
					}
				}
				if strings.Join(remoteTitles, ",") != "onBytes,refresh" {
					t.Fatalf("remote display titles: %v", remoteTitles)
				}
			}
			if name == "automation-flow" && result.Program.Scopes[0].Kind != "automation" {
				t.Fatal("not Automation")
			}
		})
	}
}
func TestAnalyzeInvalidInput(t *testing.T) {
	t.Parallel()
	for _, files := range []Files{nil, {}, {"main.bal": ""}, project("public function main( {"), project("public function main() { int x = true + 2; _ = x; }"), {"Ballerina.toml": manifest, "tests/test.bal": ""}} {
		result, err := Analyze(files)
		if err != nil || result.Kind != "invalid" || len(result.Diagnostics) == 0 || result.Program != nil {
			t.Fatalf("files=%v: %+v %v", files, result, err)
		}
	}
}

func TestAnalysisIsNotFullChecking(t *testing.T) {
	t.Parallel()
	files := project("public function main() { int x = \"bad\"; _ = x; }")
	analysis, err := Analyze(files)
	if err != nil || analysis.Kind != "valid" {
		t.Fatalf("local resolution: %+v %v", analysis, err)
	}
	checked, err := Check(files)
	if err != nil || len(checked.Diagnostics) == 0 {
		t.Fatalf("full checking: %+v %v", checked, err)
	}
}

func TestResolvedDiscoveryAndTargets(t *testing.T) {
	t.Parallel()
	result, err := Analyze(exampleFiles(t, "definitions-and-calls"))
	if err != nil {
		t.Fatal(err)
	}
	scope := result.Program.Scopes[0]
	kinds := map[string]string{}
	for _, def := range *scope.Definitions {
		kinds[def.Label] = def.Kind
	}
	for _, name := range []string{"calculate", "unusedHelper"} {
		if kinds[name] != "function" {
			t.Fatalf("missing module function %s", name)
		}
	}
	if kinds["UnusedRecord"] != "type" || kinds["upstreamClient"] != "connector" {
		t.Fatalf("definitions: %+v", kinds)
	}
	endpoint := (*scope.Endpoints)[0]
	calls := hirTestReferences(result.Program.Functions[endpoint.FunctionID])
	if len(calls) < 2 {
		t.Fatalf("missing calls: %+v", calls)
	}
	local, remote := calls[0], calls[1]
	if local.Reference.GraphID == remote.Reference.GraphID {
		t.Fatal("same-name functions were conflated")
	}
	if result.Program.Functions[local.Reference.GraphID].Source.File != "helpers.bal" || result.Program.Functions[remote.Reference.GraphID].Source.File != "modules/math/calculate.bal" {
		t.Fatal("wrong resolved source targets")
	}
	for _, def := range *scope.Definitions {
		if def.Label == "unusedHelper" {
			calls := hirTestReferences(result.Program.Functions[def.FunctionID])
			if len(calls) != 1 {
				t.Fatalf("workspace client calls: %+v", calls)
			}
			call := calls[0]
			if result.Program.Functions[call.Reference.GraphID].Source.File != "main.bal" {
				t.Fatalf("workspace client method misclassified: %+v", call)
			}
		}
	}
	files := exampleFiles(t, "definitions-and-calls")
	files["unrelated.bal"] = "// harmless new file\n"
	edited, err := Analyze(files)
	if err != nil {
		t.Fatal(err)
	}
	if edited.Program.Scopes[0].ID != scope.ID {
		t.Fatal("harmless edit changed service identity")
	}
}
func TestRangesAndSupportedBlocks(t *testing.T) {
	t.Parallel()
	result, err := Analyze(exampleFiles(t, "source-ranges"))
	if err != nil {
		t.Fatal(err)
	}
	main := result.Program.Functions[result.Program.Scopes[0].FunctionID]
	declaration := hirTestSource(t, result.Program, main, "string greeting = \"Hello 🚀 café\";")
	if declaration.Text != "string greeting = \"Hello 🚀 café\";" || declaration.Source.Range.Start != (Position{3, 5}) {
		t.Fatalf("Unicode source: %+v", declaration)
	}
	found := false
	for _, fn := range result.Program.Functions {
		if fn.Source.File == "windows.bal" {
			found = true
			if !strings.Contains(fn.Text, "\r\n") {
				t.Fatal("CRLF source normalized")
			}
			foundStatement := false
			for _, node := range fn.Nodes {
				if source := result.Program.Sources[node.SourceID]; source.Source.Range.Start == (Position{2, 5}) {
					foundStatement = true
				}
			}
			if !foundStatement {
				t.Fatal("missing CRLF statement range")
			}
		}
	}
	if !found {
		t.Fatal("missing cross-file function")
	}
	design, err := Analyze(exampleFiles(t, "design-critique"))
	if err != nil {
		t.Fatal(err)
	}
	for _, fn := range design.Program.Functions {
		for _, node := range fn.Nodes {
			if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleUnsupported {
				t.Fatalf("supported source became limited: %+v", p)
			}
		}
	}
}

func TestArithmeticCallExpansion(t *testing.T) {
	t.Parallel()
	result, err := Analyze(project(`import ballerina/http;
import ballerina/io;
service / on new http:Listener(8080) {
 resource function get hello() returns string { return "Hello, World!"; }
 resource function get [int x]/[int y]/sum() returns int {
  io:println("x: ", x, ", y: ", y);
  return fib(x) + fib(y);
 }
}
function fib(int n) returns int {
 if n <= 1 { return n; }
 return fib(n - 1) + fib(n - 2);
}`))
	if err != nil || result.Kind != "valid" {
		t.Fatalf("analysis: %+v, %v", result, err)
	}
	var fibID string
	for id, fn := range result.Program.Functions {
		if fn.Entry.Name == "fib" {
			fibID = id
		}
	}
	if fibID == "" {
		t.Fatal("missing fib definition")
	}
	checked := 0
	for _, fn := range result.Program.Functions {
		var want []string
		if strings.Contains(fn.Text, "return fib(x) + fib(y);") {
			want = []string{"fib(x)", "fib(y)"}
		}
		if fn.Entry.Name == "fib" {
			want = []string{"fib(n - 1)", "fib(n - 2)"}
		}
		if want == nil {
			continue
		}
		checked++
		// Preserve emitted node order and resolve each actual reference's source;
		// finding both expected snippets elsewhere would miss swapped source IDs.
		var calls []HIRNode
		for _, node := range fn.Nodes {
			if _, ok := node.Body.Value.(HIRReferenceBody); ok {
				calls = append(calls, node)
			}
		}
		if len(calls) != 2 {
			t.Fatalf("missing return calls: %+v", calls)
		}
		for i, node := range calls {
			call := node.Body.Value.(HIRReferenceBody)
			if call.Reference.GraphID != fibID {
				t.Fatalf("call target: %+v", call)
			}
			if _, ok := call.Reference.Availability.Value.(HIRAvailable); !ok {
				t.Fatalf("unavailable call: %+v", call)
			}
			source, ok := result.Program.Sources[node.SourceID]
			if !ok || source.Text != want[i] || source.ID != node.SourceID || source.Source.File != fn.Source.File {
				t.Fatalf("reference %d source %q: %+v, want %q", i, node.SourceID, source, want[i])
			}
		}
	}
	if checked != 2 {
		t.Fatalf("checked %d returns, want 2", checked)
	}
}

func TestArithmeticExpansionRespectsEvaluationContext(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		expr string
		want []string
	}{
		{"value(1) + value(2) * value(3)", []string{"supported", "supported", "supported"}},
		{"(value(1) - value(2)) / value(3) % value(4)", []string{"supported", "supported", "supported", "supported"}},
		{"value(value(1) + value(2))", []string{"unavailable", "unavailable", "unavailable"}},
		{"(value(1) + value(2) > 0) && (value(3) + value(4) > 0)", []string{"unavailable", "unavailable", "unavailable", "unavailable"}},
		{"(value(1) > 0) || (value(2) > 0)", []string{"unavailable", "unavailable"}},
		{"true ? value(1) + value(2) : value(3)", []string{"unavailable", "unavailable", "unavailable"}},
	} {
		t.Run(tc.expr, func(t *testing.T) {
			result, err := Analyze(project("public function main() { var result = " + tc.expr + "; _ = result; } function value(int n) returns int { return n; }"))
			if err != nil || result.Kind != "valid" {
				t.Fatalf("analysis: %+v, %v", result, err)
			}
			main := result.Program.Functions[result.Program.Scopes[0].FunctionID]
			calls := hirTestReferences(main)
			if len(calls) != len(tc.want) {
				t.Fatalf("missing calls: %+v", calls)
			}
			for i, call := range calls {
				_, available := call.Reference.Availability.Value.(HIRAvailable)
				wantAvailable := tc.want[i] == "supported"
				if available != wantAvailable {
					t.Fatalf("call %d availability: %+v", i, call)
				}
			}
		})
	}
}

package compiler

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestHIRFunctionViews(t *testing.T) {
	source := `import ballerina/io;
function main() returns int {
    io:println("😀", next(1));
    int count = next(next(1)) + next(2);
    if valid(next(count)) { count = next(count); }
    while valid(count) { count = next(count); break; }
    foreach int item in [next(1)] { count = next(item); }
    return next(count);
}
function next(int value) returns int { return next(value); }
function valid(int value) returns boolean { return value > 0; }
`
	p, diagnostics, err := resolveProgram(project(source))
	if err != nil || p == nil {
		t.Fatalf("resolve: %v %+v", err, diagnostics)
	}
	canonical, err := lowerProgram(p)
	if err != nil {
		t.Fatal(err)
	}
	program, err := lowerProgramMode(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(canonical.Functions, program.Functions) || !reflect.DeepEqual(canonical.Sources, program.Sources) {
		t.Fatal("canonical graph or sources changed")
	}
	if err := ValidateHIR(program); err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, graph := range program.FunctionViews {
		for _, node := range graph.Nodes {
			if strings.Contains(node.ID, "/evaluation") || strings.Contains(node.ID, "/expand/") {
				t.Fatalf("expanded node %s", node.ID)
			}
			label := node.Presentation.Value.(HIRPlainPresentation).Label
			units := utf16.Encode([]rune(label))
			for _, call := range node.Calls {
				count++
				token := string(utf16.Decode(units[call.Start:call.End]))
				if token == "println" {
					if call.TargetID != nil || call.Unavailable == nil {
						t.Fatal("external call must be unavailable")
					}
					continue
				}
				if token != "next" && token != "valid" {
					t.Fatalf("not a function token: %q (%s)", token, label)
				}
				if call.TargetID == nil || !strings.HasSuffix(*call.TargetID, "/"+token) {
					t.Fatalf("incorrect target: %+v", call)
				}
			}
		}
	}
	if count != 14 {
		t.Fatalf("got %d calls, want 14", count)
	}
	data, err := json.Marshal(program)
	if err != nil {
		t.Fatal(err)
	}
	var decoded HIRProgram
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateHIR(decoded); err != nil {
		t.Fatal(err)
	}
}

func TestHIRFunctionViewsPreserveEvaluation(t *testing.T) {
	for _, source := range []string{
		`function value() returns int|error { return 1; } function main() returns int|error { return check value(); }`,
		`function value() returns int|error { return 1; } function main() returns int { return checkpanic value(); }`,
		`function value() returns int|error { return 1; } function main() returns int|error { return trap checkpanic value(); }`,
		`function message() returns string { return "message"; } function main() returns error => error(message(), code = 42);`,
		`function message() returns string { return "message"; } function main() returns string => string ` + "`hello ${message()}`" + `;`,
		`import ballerina/http; final http:Client c = check new ("https://example.test"); function main() returns error? { string response = check c->get("/"); _ = response; }`,
		`function value() returns int|error { return 1; } function main(boolean flag) returns boolean|error { return flag && (check value()) > 0; }`,
	} {
		t.Run(source, func(t *testing.T) {
			p, diagnostics, err := resolveProgram(project(source))
			if err != nil || p == nil {
				t.Fatalf("resolve: %v %+v", err, diagnostics)
			}
			canonical, err := lowerProgram(p)
			if err != nil {
				t.Fatal(err)
			}
			program, err := lowerProgramMode(p, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateHIR(program); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(canonical.Functions, program.Functions) || !reflect.DeepEqual(canonical.Sources, program.Sources) {
				t.Fatal("canonical graph or sources changed")
			}
			for id, graph := range program.FunctionViews {
				// Effect/structured presentation nodes must survive unchanged;
				// only call disclosure/reference expansion is intentionally removed.
				for _, original := range canonical.Functions[id].Nodes {
					if strings.Contains(original.ID, "/expand/") {
						continue
					}
					var found *HIRNode
					for i := range graph.Nodes {
						if graph.Nodes[i].ID == original.ID {
							found = &graph.Nodes[i]
							break
						}
					}
					if found == nil {
						t.Fatalf("lost node %s", original.ID)
					}
					if !reflect.DeepEqual(original.Presentation, found.Presentation) {
						// Workspace evaluation calls lose only their old expansion disclosure.
						a, aok := original.Presentation.Value.(HIRPlainPresentation)
						z, zok := found.Presentation.Value.(HIRPlainPresentation)
						if !aok || !zok || a.Style != z.Style || a.Label != z.Label || !reflect.DeepEqual(a.Sections, z.Sections) || !reflect.DeepEqual(a.Limitation, z.Limitation) {
							t.Fatalf("presentation changed: %s", original.ID)
						}
					}
					var label HIRText
					switch p := found.Presentation.Value.(type) {
					case HIRPlainPresentation:
						label = p.Label
						if strings.Contains(string(label), "Error: message()") && len(found.Calls) != 1 {
							t.Fatal("structured constructor lost its function link")
						}
					case HIRClientPresentation:
						label = p.Label
						if len(found.Calls) != 1 || found.Calls[0].Unavailable == nil {
							t.Fatal("client lost its method availability link")
						}
					}
					units := utf16.Encode([]rune(label))
					for _, call := range found.Calls {
						if call.Start < 0 || call.End > len(units) || call.End <= call.Start {
							t.Fatalf("invalid call span on %s", found.ID)
						}
						token := string(utf16.Decode(units[call.Start:call.End]))
						if token != "message" && token != "value" && token != "get" {
							t.Fatalf("not a function name: %q", token)
						}
					}
					if strings.Contains(found.ID, "/evaluation") {
						if plain, ok := found.Presentation.Value.(HIRPlainPresentation); ok && plain.Label == "value()" && len(found.Calls) != 1 {
							t.Fatal("evaluation call lost its name link")
						}
					}
				}
				for _, edge := range canonical.Functions[id].Edges {
					if edge.Kind != HIREdgeKindError && edge.Kind != HIREdgeKindPanic {
						continue
					}
					found := false
					for _, actual := range graph.Edges {
						if edge.FromPort == actual.FromPort && edge.ToPort == actual.ToPort && reflect.DeepEqual(edge.HIREdgeStyle, actual.HIREdgeStyle) {
							found = true
							break
						}
					}
					if !found {
						t.Fatalf("lost effect edge %+v", edge)
					}
				}
			}
		})
	}
}

package compiler

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// These are new post-baseline lowering scenarios, not additions to the frozen
// render corpus. Compare the entire control structure, including emission and
// expansion guards; source text and presentation labels deliberately differ.
func castTestGraph(t *testing.T, body string) HIRGraph {
	t.Helper()
	source := `function value() returns int { return 1; }
function fallible() returns int|error { return 1; }
function main(any input, boolean flag) returns int|error { _ = input; _ = flag; ` + body + ` }`
	p, diagnostics, err := resolveProgram(project(source))
	if err != nil || p == nil {
		t.Fatalf("resolve: %v: %+v", err, diagnostics)
	}
	program, err := lowerProgram(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateHIR(program); err != nil {
		t.Fatal(err)
	}
	for _, graph := range program.Functions {
		if graph.Entry.Name == "main" {
			return graph
		}
	}
	t.Fatal("missing main graph")
	return HIRGraph{}
}

func castTestControl(t *testing.T, graph HIRGraph) any {
	t.Helper()
	// Keep node identity, occurrence, body/reference availability, and style, but
	// not source-derived labels, locations, or disclosure text.
	type node struct {
		ID, Occurrence string
		Body           HIRNodeBody
		Style          HIRNodeStyle
	}
	nodes := []node{}
	for _, n := range graph.Nodes {
		var style HIRNodeStyle
		if p, ok := n.Presentation.Value.(HIRPlainPresentation); ok {
			style = p.Style
		}
		nodes = append(nodes, node{n.ID, n.OccurrenceKey, n.Body, style})
	}
	data, err := json.Marshal(struct {
		Nodes      []node
		Ports      HIRList[HIRPort]
		Edges      HIRList[HIREdge]
		Groups     HIRList[HIRGroup]
		Root       string
		Interfaces HIRList[HIRInterface]
		Emission   HIREmissionModes
	}{nodes, graph.Ports, graph.Edges, graph.Groups, graph.RootGroup, graph.Interfaces, graph.Emission})
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestHIRTypeCastTransparentFlow(t *testing.T) {
	tests := []struct{ name, plain, cast string }{
		{"declaration", "int n = 1; return n;", "int n = <int>1; return n;"},
		{"assignment", "int n = 0; n = 1; return n;", "int n = 0; n = <int>1; return n;"},
		{"return", "return 1;", "return <int>1;"},
		{"narrow-any", "var n = input; _ = n; return 1;", "var n = <int>input; _ = n; return 1;"},
		{"nested", "return value();", "return <int><any>value();"},
		{"call-declaration", "int n = value(); return n;", "int n = <int>value(); return n;"},
		{"call-assignment", "int n = 0; n = value(); return n;", "int n = 0; n = <int>value(); return n;"},
		{"check", "return check fallible();", "return <int>(check fallible());"},
		{"checkpanic", "return checkpanic fallible();", "return <int>(checkpanic fallible());"},
		{"trap", "var n = trap checkpanic fallible(); _ = n; return 1;", "var n = <int|error>(trap checkpanic fallible()); _ = n; return 1;"},
		{"check-operand", "return check fallible();", "return check <int|error>fallible();"},
		{"checkpanic-operand", "return checkpanic fallible();", "return checkpanic <int|error>fallible();"},
		{"trap-operand", "var n = trap checkpanic fallible(); _ = n; return 1;", "var n = trap <int>(checkpanic fallible()); _ = n; return 1;"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plain := castTestGraph(t, test.plain)
			cast := castTestGraph(t, test.cast)
			if !reflect.DeepEqual(castTestControl(t, plain), castTestControl(t, cast)) {
				t.Fatalf("cast changed control structure:\nplain: %+v\ncast: %+v", castTestControl(t, plain), castTestControl(t, cast))
			}
			for _, n := range cast.Nodes {
				if p, ok := n.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleUnsupported {
					t.Fatalf("cast became unsupported: %+v", p)
				}
			}
		})
	}
}

func TestHIRTypeCastSourceLabels(t *testing.T) {
	for _, statement := range []string{
		"int café = <int>input;",
		"input = <int><any>1;",
		"return <int>value();",
	} {
		t.Run(statement, func(t *testing.T) {
			body := statement
			if strings.Contains(statement, "café") {
				body += " _ = café;"
			}
			graph := castTestGraph(t, body)
			found := false
			for _, n := range graph.Nodes {
				if p, ok := n.Presentation.Value.(HIRPlainPresentation); ok && string(p.Label) == statement {
					found = true
				}
			}
			if !found {
				t.Fatalf("cast statement source label lost: %s", statement)
			}
		})
	}
}

func TestHIRTypeCastCallExpansion(t *testing.T) {
	for _, expression := range []string{"<int>value()", "<int><any>value()", "<int>(check fallible())", "<int>(checkpanic fallible())", "<int|error>(trap checkpanic fallible())"} {
		t.Run(expression, func(t *testing.T) {
			graph := castTestGraph(t, "var n = "+expression+"; _ = n; return 1;")
			references := 0
			for _, n := range graph.Nodes {
				if body, ok := n.Body.Value.(HIRReferenceBody); ok {
					references++
					if _, ok := body.Reference.Availability.Value.(HIRAvailable); !ok {
						t.Fatalf("cast operand call is not expandable: %+v", body)
					}
					presentation, ok := n.Presentation.Value.(HIRPlainPresentation)
					if !ok {
						t.Fatalf("missing call presentation: %+v", n)
					}
					disclosure, ok := presentation.Disclosure.Value.(HIRCallDisclosure)
					if !ok || disclosure.OccurrenceKey != body.Reference.OccurrenceKey || disclosure.OccurrenceKey == "" {
						t.Fatalf("lost occurrence-local expansion: %+v", n)
					}
				}
			}
			if references != 1 {
				t.Fatalf("operand references: %d, want 1", references)
			}
		})
	}
}

func TestHIRTypeCastConditionalLimitations(t *testing.T) {
	for _, test := range []struct{ plain, cast string }{
		{"var n = flag ? check fallible() : 1; _ = n; return 1;", "var n = flag ? <int>(check fallible()) : 1; _ = n; return 1;"},
		{"var n = flag && (check fallible() > 0); _ = n; return 1;", "var n = flag && (<int>(check fallible()) > 0); _ = n; return 1;"},
	} {
		t.Run(test.cast, func(t *testing.T) {
			plain, cast := castTestGraph(t, test.plain), castTestGraph(t, test.cast)
			if !reflect.DeepEqual(castTestControl(t, plain), castTestControl(t, cast)) {
				t.Fatal("cast changed conditional limitations/control structure")
			}
			data, err := json.Marshal(cast)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(data), "Error operators in conditionally evaluated operands are not modeled.") {
				t.Fatal("cast lost existing conditional limitation")
			}
		})
	}
}

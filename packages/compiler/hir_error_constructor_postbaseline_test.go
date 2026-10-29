package compiler

import (
	"strings"
	"testing"
)

// New coverage lives outside the immutable baseline corpus.
func errorConstructorProgram(t *testing.T, source string) HIRProgram {
	t.Helper()
	result, err := Analyze(project(source))
	if err != nil || result.Kind != "valid" || result.Program == nil {
		t.Fatalf("analyze: %v: %+v", err, result)
	}
	return *result.Program
}

func TestErrorConstructorPostbaselinePresentation(t *testing.T) {
	program := errorConstructorProgram(t, `public function main() {
 string message = "variable";
 error original = error("root");
 error e = error(message, error("middle", original, code = 12), code = 42, info = "all visible");
 _ = e;
 }`)
	want := "Error: message\nCause:\n  Error: \"middle\"\n  Cause: original\n  Details:\n    code: 12\nDetails:\n  code: 42\n  info: \"all visible\""
	found := false
	for _, graph := range program.Functions {
		for _, face := range graph.Interfaces {
			if (face.ID == "panics" || face.ID == "returns") && (len(face.Members) != 0 || len(face.Exports) != 0) {
				t.Fatalf("pure constructor arguments introduce control effects: %+v", face)
			}
		}
		for _, node := range graph.Nodes {
			p, ok := node.Presentation.Value.(HIRPlainPresentation)
			if !ok || p.Style != HIRNodeStyleErrorConstructor {
				continue
			}
			var label strings.Builder
			for _, section := range p.Sections {
				if section.Kind != HIRLabelSectionKindErrorMessage && section.Kind != HIRLabelSectionKindErrorCause && section.Kind != HIRLabelSectionKindErrorDetail {
					t.Fatalf("unexpected section: %+v", section)
				}
				label.WriteString(string(section.Text))
			}
			if label.String() != string(p.Label) {
				t.Fatal("section/measurement label mismatch")
			}
			if string(p.Label) == want {
				found = true
			}
			for _, port := range graph.Ports {
				if port.NodeID == node.ID && (port.Role == HIRPortRolePanic || port.Role == HIRPortRoleReturn) {
					t.Fatalf("constructor adds effect: %+v", port)
				}
			}
		}
	}
	if !found {
		t.Fatalf("missing readable constructor label %q", want)
	}
	if _, err := PrintHIR(program); err != nil {
		t.Fatal(err)
	}
}

func TestErrorConstructorPostbaselineContexts(t *testing.T) {
	for _, source := range []string{
		`public function main() { error e = error("first"); e = error("assigned"); _ = e; }`,
		`function main() returns error { return error("returned"); }`,
		`function main() returns error => error("expression body");`,
		`type OrderError distinct error; function main() returns OrderError => error OrderError("typed");`,
		`public function main() { error e = error("with detail", code = 42); _ = e; }`,
		`public function main() { error[] errors = [error("list")]; _ = errors; }`,
		`function use(error value) { _ = value; } public function main() { use(error("argument")); }`,
		`public function main() { map<error> errors = {value: error("mapping")}; _ = errors; }`,
	} {
		t.Run(source, func(t *testing.T) {
			program := errorConstructorProgram(t, source)
			count := 0
			for _, graph := range program.Functions {
				for _, node := range graph.Nodes {
					if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok {
						if p.Style == HIRNodeStyleUnsupported {
							t.Fatalf("unsupported: %s", p.Label)
						}
						if p.Style == HIRNodeStyleErrorConstructor {
							count++
						}
					}
				}
			}
			if count == 0 {
				t.Fatal("constructor not visible")
			}
		})
	}
}

func TestErrorConstructorPostbaselineNestedCauseIsNotFlow(t *testing.T) {
	for _, source := range []string{
		`function main() returns error => error("outer", error("inner", error("root")));`,
		`function main() returns error => error("outer", (error("inner", error("root"))));`,
	} {
		program := errorConstructorProgram(t, source)
		for _, graph := range program.Functions {
			count := 0
			for _, node := range graph.Nodes {
				if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleErrorConstructor {
					count++
					if !strings.Contains(string(p.Label), "Cause:\n  Error: \"inner\"\n  Cause:\n    Error: \"root\"") {
						t.Fatalf("missing nested presentation: %s", p.Label)
					}
				}
			}
			if count != 1 {
				t.Fatalf("nested cause emitted standalone flow nodes: %d", count)
			}
		}
	}
}

func TestErrorConstructorPostbaselineNestedCausePreservesEffects(t *testing.T) {
	program := errorConstructorProgram(t, `function message() returns string|error => "message";
 function detail() returns int => 42;
 function main() returns error {
 return error(check message(), error("nested", error("root"), code = detail()));
 }`)
	for _, graph := range program.Functions {
		if graph.Entry.Name != "main" {
			continue
		}
		var calls []string
		constructors := 0
		for _, node := range graph.Nodes {
			if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleErrorConstructor {
				constructors++
			}
			if ref, ok := node.Body.Value.(HIRReferenceBody); ok {
				calls = append(calls, program.Functions[ref.Reference.GraphID].Entry.Name)
			}
		}
		if constructors != 1 || strings.Join(calls, ",") != "message,detail" {
			t.Fatalf("nested cause lost argument effects or created flow nodes: constructors=%d calls=%v", constructors, calls)
		}
	}
}

func TestErrorConstructorPostbaselineCheckpanic(t *testing.T) {
	program := errorConstructorProgram(t, `function message() returns string|error => "message";
 public function main() { error e = error(checkpanic message()); _ = e; }`)
	found := false
	for _, graph := range program.Functions {
		if graph.Entry.Name != "main" {
			continue
		}
		for _, node := range graph.Nodes {
			if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleCondition && p.Label == "checkpanic" {
				found = true
			}
		}
		for _, face := range graph.Interfaces {
			if face.ID == "panics" && len(face.Members) == 0 && len(face.Exports) == 0 {
				t.Fatal("constructor swallowed argument panic")
			}
			if face.ID == "returns" && (len(face.Members) != 0 || len(face.Exports) != 0) {
				t.Fatal("constructor converted panic into return")
			}
		}
	}
	if !found {
		t.Fatal("missing argument checkpanic")
	}
}

func TestErrorConstructorPostbaselineArgumentEffects(t *testing.T) {
	program := errorConstructorProgram(t, `function message() returns string|error => "message";
 function cause() returns error => error("cause");
 function detail() returns int => 42;
 public function main() returns error? {
 error e = error(check message(), trap cause(), code = detail()); _ = e;
 }`)
	var main HIRGraph
	for _, graph := range program.Functions {
		if graph.Entry.Name == "main" {
			main = graph
		}
	}
	var calls []string
	hasCheck, hasTrap := false, false
	for _, node := range main.Nodes {
		p, ok := node.Presentation.Value.(HIRPlainPresentation)
		if !ok {
			continue
		}
		if p.Style == HIRNodeStyleCondition && p.Label == "check" {
			hasCheck = true
		}
		if p.Style == HIRNodeStyleTrap {
			hasTrap = true
		}
		if ref, ok := node.Body.Value.(HIRReferenceBody); ok {
			calls = append(calls, program.Functions[ref.Reference.GraphID].Entry.Name)
			if _, ok := ref.Reference.Availability.Value.(HIRAvailable); !ok {
				t.Fatalf("safe argument call unavailable: %s", p.Label)
			}
		}
	}
	if strings.Join(calls, ",") != "message,cause,detail" {
		t.Fatalf("evaluation order: %v", calls)
	}
	if !hasCheck || !hasTrap {
		t.Fatalf("lost argument operators: check=%t trap=%t", hasCheck, hasTrap)
	}
}

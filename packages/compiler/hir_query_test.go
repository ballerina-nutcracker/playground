package compiler

import (
	"strings"
	"testing"
	"unicode/utf16"
)

func TestHIRQueriesRemainSourceExpressions(t *testing.T) {
	for _, body := range []string{
		`int[] result = from int value in values where positive(value) select next(value); return result;`,
		`int[] result = []; result = from int value in values select next(value); return result;`,
		`return from int value in values select next(value);`,
		`return (from int value in values select next(value));`,
		`return identity(from int value in values select next(value));`,
		`return from int value in values let int adjusted = next(value) where positive(adjusted) order by adjusted descending limit 2 select adjusted;`,
		`return from int value in values join int other in values on value equals other select next(other);`,
		`return from int value in values group by value select next(value);`,
		`return from int value in values select next(next(value));`,
		`return from int value in values select checkpanic fallible(next(value));`,
		`return from int value in values select demo([next(value)])[0];`,
	} {
		t.Run(body, func(t *testing.T) {
			assertQuerySource(t, `function demo(int[] values) returns int[] { `+body+` }
function next(int value) returns int => value + 1;
function positive(int value) returns boolean => value > 0;
function identity(int[] value) returns int[] => value;
function fallible(int value) returns int|error => value;`)
		})
	}
	t.Run("map query", func(t *testing.T) {
		assertQuerySource(t, `function demo(int[] values) returns map<int> => map from int value in values select [value.toString(), next(value)];
function next(int value) returns int => value + 1;`)
	})
	t.Run("expression body", func(t *testing.T) {
		assertQuerySource(t, `function demo(int[] values) returns int[] => from int value in values select next(value);
function next(int value) returns int => value + 1;`)
	})
}

func assertQuerySource(t *testing.T, source string) {
	t.Helper()
	p, diagnostics, err := resolveProgram(project(source))
	if err != nil || p == nil || len(diagnostics) != 0 {
		t.Fatalf("resolve: %v %+v", err, diagnostics)
	}
	program, err := lowerProgramMode(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateHIR(program); err != nil {
		t.Fatal(err)
	}
	for viewIndex, graphs := range []HIRRecord[HIRGraph]{program.Functions, program.FunctionViews} {
		found := false
		for _, graph := range graphs {
			if graph.Entry.Name != "demo" {
				continue
			}
			for _, node := range graph.Nodes {
				// Ordinary calls surrounding the query may still have their normal
				// legacy expansion nodes, but query clauses add no evaluation nodes.
				if strings.Contains(node.ID, "/evaluation") {
					t.Fatalf("unexpected query evaluation node: %s", node.ID)
				}
				plain, ok := node.Presentation.Value.(HIRPlainPresentation)
				if !ok {
					continue
				}
				if plain.Limitation != nil {
					t.Fatalf("unexpected limitation: %s", *plain.Limitation)
				}
				label := string(plain.Label)
				if !strings.Contains(label, "from int value") {
					continue
				}
				found = true
				if !strings.Contains(source, label) {
					t.Fatalf("query text changed: %q", label)
				}
				if len(plain.Variables) < 3 {
					t.Fatalf("query variable metadata missing: %+v", plain)
				}
				// Function views use the existing call-token mechanism, not query flow nodes.
				if viewIndex == 1 {
					units := utf16.Encode([]rune(label))
					hasNext := false
					for _, call := range node.Calls {
						token := string(utf16.Decode(units[call.Start:call.End]))
						if token == "demo" && (call.TargetID == nil || !strings.HasSuffix(*call.TargetID, "/demo")) {
							t.Fatal("recursive query call lost its target")
						}
						if token == "toString" && (call.TargetID != nil || call.Unavailable == nil) {
							t.Fatal("external query call must remain unavailable")
						}
						if token == "next" {
							hasNext = true
							if call.TargetID == nil {
								t.Fatal("query call has no target")
							}
						}
					}
					if !hasNext {
						t.Fatal("query call metadata missing")
					}
				}
			}
		}
		if !found {
			t.Fatal("query source node missing")
		}
	}
}

func TestHIRQueryVariableIdentity(t *testing.T) {
	source := `function demo(int[] values, int offset) returns int[] {
 int[] result = from int value in values
     let string note = "🚀" where value > offset && note != "" select next(value);
 int[] other = from int value in values select value;
 _ = other;
 return result;
}
function next(int value) returns int => value + 1;`
	program := variableProgram(t, source)
	for _, graph := range program.Functions {
		if graph.Entry.Name != "demo" {
			continue
		}
		outer := graph.Entry.SignatureVariables[1].VariableID
		var inner, sibling string
		count := 0
		outerSeen := false
		for _, node := range graph.Nodes {
			p, ok := node.Presentation.Value.(HIRPlainPresentation)
			if !ok {
				continue
			}
			if strings.Contains(string(p.Label), "int[] other") {
				for _, v := range p.Variables {
					if occurrenceText(string(p.Label), v) == "value" {
						sibling = v.VariableID
					}
				}
			}
			if !strings.Contains(string(p.Label), "let string note") {
				continue
			}
			for _, v := range p.Variables {
				if occurrenceText(string(p.Label), v) == "offset" {
					if v.VariableID != outer {
						t.Fatal("outer reference identity changed")
					}
					outerSeen = true
				}
				if occurrenceText(string(p.Label), v) != "value" {
					continue
				}
				if v.VariableID == outer {
					t.Fatal("query binding aliases outer variable")
				}
				if inner != "" && inner != v.VariableID {
					t.Fatal("query references have different identities")
				}
				inner = v.VariableID
				count++
			}
		}
		if !outerSeen || sibling == "" || sibling == inner {
			t.Fatal("query scopes or outer reference metadata lost")
		}
		if count != 3 {
			t.Fatalf("query binding/reference count = %d, want 3", count)
		}
		return
	}
	t.Fatal("demo graph missing")
}

package compiler

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func variableProgram(t *testing.T, source string) HIRProgram {
	t.Helper()
	p, items, err := resolveProgram(project(source))
	if err != nil || p == nil {
		for _, item := range items {
			t.Logf("%s: %+v", item.Message, item.Range)
		}
		t.Fatalf("resolve: %v %+v", err, items)
	}
	hir, err := lowerProgram(p)
	if err != nil {
		t.Fatal(err)
	}
	return hir
}

func occurrenceText(text string, v HIRVariableOccurrence) string {
	units := utf16.Encode([]rune(text))
	if v.Start < 0 || v.End > len(units) || v.Start >= v.End {
		return "<invalid>"
	}
	return string(utf16.Decode(units[v.Start:v.End]))
}

func TestVariableOccurrencesSymbols(t *testing.T) {
	source := `int moduleValue = 1;
function use(int input, int... rest) {
 int local = input;
 local += moduleValue;
 foreach int item in rest { local = item; }
 { int moduleValue = local; _ = moduleValue; }
 record {| int local; |} data = {local: local};
 _ = data.local;
 _ = "🚀 local" + local.toString();
 _ = rest;
}
public function main() { use(moduleValue); }
`
	hir := variableProgram(t, source)
	var graph HIRGraph
	for _, g := range hir.Functions {
		if g.Entry.Name == "use" {
			graph = g
		}
	}
	if len(graph.Entry.SignatureVariables) != 2 {
		t.Fatalf("signature: %+v", graph.Entry)
	}
	outer := graph.Entry.SignatureVariables[0].VariableID
	ids := map[string]map[string]bool{}
	counts := map[string]int{}
	for _, n := range graph.Nodes {
		p, ok := n.Presentation.Value.(HIRPlainPresentation)
		if !ok {
			continue
		}
		for _, v := range p.Variables {
			text := occurrenceText(string(p.Label), v)
			if ids[text] == nil {
				ids[text] = map[string]bool{}
			}
			ids[text][v.VariableID] = true
			counts[text]++
		}
		if strings.Contains(string(p.Label), "data.local") && len(p.Variables) != 1 {
			t.Fatalf("field annotated: %+v", p)
		}
		if strings.Contains(string(p.Label), "{local: local}") && len(p.Variables) != 2 {
			t.Fatalf("key annotated: %+v", p)
		}
		if strings.Contains(string(p.Label), "🚀 local") {
			if len(p.Variables) != 1 || occurrenceText(string(p.Label), p.Variables[0]) != "local" {
				t.Fatalf("string annotated: %+v", p)
			}
			expected := utf16Length(string(p.Label)[:strings.LastIndex(string(p.Label), "local")])
			if p.Variables[0].Start != expected {
				t.Fatal("offset is not UTF-16")
			}
		}
	}
	if len(ids["input"]) != 1 || !ids["input"][outer] || len(ids["moduleValue"]) != 2 {
		t.Fatalf("shadowing: %+v", ids)
	}
	for _, name := range []string{"local", "item", "rest"} {
		if len(ids[name]) != 1 || counts[name] < 2 && name != "moduleValue" {
			t.Fatalf("identity %s: %+v / %+v", name, ids, counts)
		}
	}
	recursiveChecked := false
	for _, g := range hir.Functions {
		for _, n := range g.Nodes {
			if p, ok := n.Presentation.Value.(HIRPlainPresentation); ok {
				if call, ok := p.Disclosure.Value.(HIRCallDisclosure); ok && strings.Contains(string(p.Label), "use(moduleValue)") {
					if len(p.Variables) != 1 || !reflect.DeepEqual(call.Recursive.Variables, p.Variables) {
						t.Fatal("plain recursive occurrences lost")
					}
					recursiveChecked = true
				}
			}
		}
	}
	if !recursiveChecked {
		t.Fatal("no plain call disclosure")
	}
	again := variableProgram(t, source)
	a, _ := json.Marshal(hir)
	var decoded HIRProgram
	if err := json.Unmarshal(a, &decoded); err != nil {
		t.Fatal(err)
	}
	roundTrip, err := json.Marshal(decoded)
	if err != nil || string(roundTrip) != string(a) {
		t.Fatalf("metadata wire round trip: %v", err)
	}
	b, _ := json.Marshal(again)
	if string(a) != string(b) {
		t.Fatal("variable identities are nondeterministic")
	}
}

func TestVariableOccurrencesTruncatedClientOffsets(t *testing.T) {
	hir := variableProgram(t, `client class Client {
 function init(string name) { _ = name; }
 remote function send(string text) returns string => text;
}
public function main() {
 string input = "value";
 Client caller = new ("`+strings.Repeat("a", 80)+`🚀" + input);
 _ = caller->send(input);
}`)
	for _, graph := range hir.Functions {
		for _, node := range graph.Nodes {
			p, ok := node.Presentation.Value.(HIRClientPresentation)
			if !ok {
				continue
			}
			context, ok := p.Disclosure.Value.(HIRClientContextDisclosure)
			if !ok {
				t.Fatal("not truncated")
			}
			if len(context.Collapsed.Variables) != 2 || len(context.Expanded.Variables) != 3 {
				t.Fatalf("truncated occurrences: %+v", context)
			}
			label := string(context.Collapsed.Label)
			last := context.Collapsed.Variables[1]
			if last.Start != utf16Length(label[:strings.LastIndex(label, "input")]) {
				t.Fatal("offset after split surrogate")
			}
			if utf16Length(string(hirTextFromUTF16([]uint16{0xd83d}))) != 1 {
				t.Fatal("isolated surrogate length")
			}
			return
		}
	}
	t.Fatal("no client presentation")
}

func TestVariableOccurrencesResourceParameters(t *testing.T) {
	hir := variableProgram(t, `import ballerina/http;
service /api on new http:Listener(8080) {
 resource function get [int id]/[string... tail](int maxCount) returns int { _ = tail; return id + maxCount; }
}`)
	for _, graph := range hir.Functions {
		if graph.Entry.Kind != HIREntryKindResource {
			continue
		}
		if len(graph.Entry.Parameters) != 3 {
			t.Fatalf("parameters: %+v", graph.Entry)
		}
		for _, parameter := range graph.Entry.Parameters {
			if len(parameter.Variables) != 1 {
				t.Fatalf("parameter: %+v", parameter)
			}
		}
		ids := map[string]string{}
		for _, v := range graph.Entry.SignatureVariables {
			ids[occurrenceText(graph.Entry.Signature, v)] = v.VariableID
		}
		for _, n := range graph.Nodes {
			if p, ok := n.Presentation.Value.(HIRPlainPresentation); ok {
				for _, v := range p.Variables {
					if ids[occurrenceText(string(p.Label), v)] != v.VariableID {
						t.Fatalf("path identity: %+v", v)
					}
				}
			}
		}
	}
}

func TestVariableOccurrencesResourceIdentifierTokens(t *testing.T) {
	for _, tc := range []struct{ name, declaration, reference string }{
		{"comment", "id // key\n", "id"},
		{"quoted", "'type", "'type"},
		{"escaped", `'item\-id`, `'item\-id`},
		{"escaped unicode and comment", `'\u{69}d // id\n`, `'\u{69}d`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			declaration := strings.ReplaceAll(tc.declaration, `\n`, "\n")
			hir := variableProgram(t, `import ballerina/http;
service /api on new http:Listener(8080) {
 resource function get [int `+declaration+`](int maxCount) returns int { return `+tc.reference+` + maxCount; }
}`)
			found := false
			for _, graph := range hir.Functions {
				if graph.Entry.Kind != HIREntryKindResource {
					continue
				}
				found = true
				var declarationID string
				for _, span := range graph.Entry.SignatureVariables {
					if occurrenceText(graph.Entry.Signature, span) == tc.reference {
						declarationID = span.VariableID
					}
				}
				if declarationID == "" {
					t.Fatalf("missing complete declaration token %q: %+v", tc.reference, graph.Entry)
				}
				matched := false
				for _, node := range graph.Nodes {
					if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok {
						for _, span := range p.Variables {
							if occurrenceText(string(p.Label), span) == tc.reference {
								if span.VariableID != declarationID {
									t.Fatalf("reference identity %q != %q", span.VariableID, declarationID)
								}
								matched = true
							}
						}
					}
				}
				if !matched {
					t.Fatal("missing complete reference token")
				}
			}
			if !found {
				t.Fatal("missing resource graph")
			}
		})
	}
}

func TestVariableOccurrencesClientVariants(t *testing.T) {
	hir := variableProgram(t, `client class Client {
 function init(string name) { _ = name; }
 remote function send(string text) returns string => text;
}
public function main() {
 string input = "`+strings.Repeat("x", 100)+`";
 Client caller = new (input + "`+strings.Repeat("y", 100)+`");
 string output = caller->send(input);
 _ = output;
}`)
	found := false
	for _, graph := range hir.Functions {
		for _, n := range graph.Nodes {
			p, ok := n.Presentation.Value.(HIRClientPresentation)
			if !ok {
				continue
			}
			found = true
			context, ok := p.Disclosure.Value.(HIRClientContextDisclosure)
			if !ok {
				t.Fatalf("missing context: %+v", p)
			}
			for _, content := range []HIRLabelContent{context.Collapsed, context.Expanded} {
				if len(content.Variables) != 3 {
					t.Fatalf("client occurrences: %+v", content)
				}
				for _, v := range content.Variables {
					if text := occurrenceText(string(content.Label), v); text != "caller" && text != "input" {
						t.Fatalf("wrong client span %q", text)
					}
				}
				total := 0
				for _, section := range content.Sections {
					total += len(section.Variables)
					for _, v := range section.Variables {
						if occurrenceText(string(section.Text), v) == "<invalid>" {
							t.Fatal("section span")
						}
					}
				}
				if total != len(content.Variables) {
					t.Fatal("section occurrences lost")
				}
			}
			if context.Call == nil || !reflect.DeepEqual(context.Call.Recursive.Variables, context.Collapsed.Variables) || context.ExpandedRecursive == nil || !reflect.DeepEqual(context.ExpandedRecursive.Variables, context.Expanded.Variables) {
				t.Fatal("recursive metadata missing")
			}
		}
	}
	if !found {
		t.Fatal("no client label")
	}
}

// HIR occurrence identity and display spans are not observable through runtime corpus tests.
func TestVariableOccurrencesErrorSections(t *testing.T) {
	t.Parallel()
	hir := variableProgram(t, `function demo(string message, error cause, string 'item\-id) returns error {
 return error(message + "🚀" +
 'item\-id, (error("🚀" +
 message, cause, message = "🚀" +
 'item\-id)), message = message);
}`)
	expected := []struct {
		text  string
		names []string
	}{
		{"Error: message + \"🚀\" +\n   'item\\-id", []string{"message", "'item\\-id"}},
		{"\nCause:\n", nil},
		{"  Error: \"🚀\" +\n     message", []string{"message"}},
		{"\n  Cause: cause", []string{"cause"}},
		{"\n  Details:\n    message: \"🚀\" +\n     'item\\-id", []string{"'item\\-id"}},
		{"\nDetails:\n  message: message", []string{"message"}},
	}
	found := false
	for _, graph := range hir.Functions {
		if graph.Entry.Name != "demo" {
			continue
		}
		ids := map[string]string{}
		for _, v := range graph.Entry.SignatureVariables {
			ids[occurrenceText(graph.Entry.Signature, v)] = v.VariableID
		}
		for _, node := range graph.Nodes {
			p, ok := node.Presentation.Value.(HIRPlainPresentation)
			if !ok || p.Style != HIRNodeStyleErrorConstructor {
				continue
			}
			found = true
			if len(p.Sections) != len(expected) {
				t.Fatalf("sections: %+v", p.Sections)
			}
			aggregate := HIRList[HIRVariableOccurrence]{}
			label := ""
			for i, want := range expected {
				section := p.Sections[i]
				if string(section.Text) != want.text {
					t.Fatalf("section %d text: %q != %q", i, section.Text, want.text)
				}
				if len(section.Variables) != len(want.names) {
					t.Fatalf("section %d occurrences: %+v", i, section.Variables)
				}
				for j, name := range want.names {
					start := utf16Length(want.text[:strings.LastIndex(want.text, name)])
					v := section.Variables[j]
					if ids[name] == "" || v.VariableID != ids[name] || v.Start != start || v.End != start+utf16Length(name) || occurrenceText(want.text, v) != name {
						t.Fatalf("section %d occurrence %q: %+v (identity %q, start %d)", i, name, v, ids[name], start)
					}
					aggregate = append(aggregate, HIRVariableOccurrence{VariableID: ids[name], Start: utf16Length(label) + start, End: utf16Length(label) + start + utf16Length(name)})
				}
				label += want.text
			}
			if string(p.Label) != label || !reflect.DeepEqual(p.Variables, aggregate) {
				t.Fatalf("aggregate: %+v; want %+v", p, aggregate)
			}
		}
	}
	if !found {
		t.Fatal("missing error presentation")
	}
}

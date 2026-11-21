package compiler

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/ballerina-nutcracker/ballerina/ast"
)

func TestLoweringMetadata(t *testing.T) {
	files := project(`import ballerina/http;
service /orders on new http:Listener(8080) {
 resource function get [int id](boolean includeItems = false) returns string { _ = id; _ = includeItems; return "order"; }
 remote function refresh(string note = "") returns boolean { _ = note; return true; }
}
class PricingEngine {
 function quote(decimal subtotal) returns decimal { return subtotal; }
}
function identity(int value) returns int => value;
public function main() {}
`)
	p, items, err := resolveProgram(files)
	if err != nil {
		t.Fatal(err)
	}
	if p == nil {
		t.Fatalf("resolve: %+v", items)
	}
	l := &lowerer{p: p}
	functions, err := l.collectFunctions()
	if err != nil {
		t.Fatal(err)
	}
	if err := l.collectReceiverContexts(); err != nil {
		t.Fatal(err)
	}
	scopes, err := l.lowerScopes()
	if err != nil {
		t.Fatal(err)
	}
	if len(scopes) != 1 || scopes[0].Title != "/orders" {
		t.Fatalf("scopes: %+v", scopes)
	}
	entries := map[string]HIREntry{}
	for _, fn := range functions {
		entry, err := l.lowerEntry(fn)
		if err != nil {
			t.Fatal(err)
		}
		entries[entry.Name] = entry
		if !l.availableBodies[fn.id] {
			t.Errorf("missing body: %s", fn.id)
		}
		if strings.Contains(entry.Signature, "=>") {
			t.Errorf("body in signature: %q", entry.Signature)
		}
	}
	resource := entries["/orders/[int id]"]
	if resource.Kind != HIREntryKindResource || resource.Operation == nil || *resource.Operation != "get" || resource.ReturnType != "string" {
		t.Fatalf("resource: %+v", resource)
	}
	want := HIRList[HIREntryParameter]{{Label: HIRParameterLabelPath, Text: "[int id]"}, {Label: HIRParameterLabelInput, Text: "boolean includeItems = false"}}
	if !reflect.DeepEqual(resource.Parameters, want) {
		t.Fatalf("parameters: %+v", resource.Parameters)
	}
	method := entries["PricingEngine.quote"]
	if method.Kind != HIREntryKindMethod || method.Owner != nil {
		t.Fatalf("method: %+v", method)
	}
	if resource.Owner == nil || !strings.HasPrefix(*resource.Owner, "Service /orders") {
		t.Fatalf("owner: %+v", resource)
	}
	for id, value := range l.sources {
		if value.ID != id {
			t.Errorf("source key mismatch: %s", id)
		}
	}
	// Repeating the operation creates no conflicting IDs, does not write frontend
	// flow caches, and preserves metadata even when parameter text is identical.
	second := &lowerer{p: p}
	if _, err := second.collectFunctions(); err != nil {
		t.Fatal(err)
	}
	if err := second.collectReceiverContexts(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.lowerScopes(); err != nil {
		t.Fatal(err)
	}
	for _, fn := range second.functions {
		if _, err := second.lowerEntry(fn); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(l.sources, second.sources) {
		t.Fatal("nondeterministic metadata sources")
	}
	for _, name := range []string{"functionIDs", "receiverContexts", "availableBodies"} {
		if _, exists := reflect.TypeOf(*p).FieldByName(name); exists {
			t.Fatalf("frontend retains legacy flow cache %s", name)
		}
	}
	// Invalid source identities fail instead of silently replacing earlier values.
	fn := functions[0]
	if _, err := l.located(fn.id, fn.node); err != nil {
		t.Fatal(err)
	}
	for _, other := range functions[1:] {
		if _, err := l.located(fn.id, other.node); err == nil {
			t.Fatal("accepted conflicting source ID")
		}
		break
	}
	if _, err := l.located("missing", nil); err == nil {
		t.Fatal("accepted missing source")
	}
}

func TestLowerCallRecursivePresentationPrecedence(t *testing.T) {
	for _, evaluation := range []bool{false, true} {
		for _, supported := range []bool{false, true} {
			b := graphBuilder{graph: HIRGraph{ID: "main"}, ports: map[string]bool{}}
			node := b.allocNode("call", "/call", "source", plain(HIRNodeStyleFunction, "literal chosen label"))
			b.bindCallReference(node, "/expand", directCall{target: "main", supported: supported, reason: "Source body unavailable."}, evaluation)
			p := b.node(node).Presentation.Value.(HIRPlainPresentation)
			r := p.Disclosure.Value.(HIRCallDisclosure).Recursive
			reason := "Recursive calls remain collapsed."
			if !evaluation && !supported {
				reason = "Source body unavailable."
			}
			if r.Limitation == nil || *r.Limitation != reason || r.Title != HIRText(reason) || r.AriaLabel != "Recursive call literal chosen label" || r.Glyph != "↻" || r.Label != p.Label || len(r.Sections) != 0 {
				t.Fatalf("evaluation=%v supported=%v: %+v", evaluation, supported, r)
			}
		}
	}
}

func TestLoweringWorkspaceClientCallDisclosures(t *testing.T) {
	for _, long := range []bool{false, true} {
		name, host := "short", "broker"
		if long {
			name, host = "long", strings.Repeat("broker-context-", 12)
		}
		t.Run(name, func(t *testing.T) {
			files := project(`client class Queue {
 public function init(string host) { _ = host; }
 remote function unavailable() returns string = external;
 remote function send() returns string {
  Queue recursive = new ("` + host + `");
  return recursive->send();
 }
}
public function main() {
 Queue direct = new ("` + host + `");
 string result = direct->send();
 string unavailable = direct->unavailable();
 _ = result;
 _ = unavailable;
}`)
			resolved, diagnostics, err := resolveProgram(files)
			if err != nil || resolved == nil {
				t.Fatalf("resolve: %v: %+v", err, diagnostics)
			}
			program, err := lowerProgram(resolved)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateHIR(program); err != nil {
				t.Fatal(err)
			}
			// Exercise the same pointer-normalizing, strict wire path as consumers.
			data, err := json.Marshal(program)
			if err != nil {
				t.Fatal(err)
			}
			var wire HIRProgram
			if err := json.Unmarshal(data, &wire); err != nil {
				t.Fatal(err)
			}
			direct, recursive, unavailable := 0, 0, 0
			for _, graph := range wire.Functions {
				for _, node := range graph.Nodes {
					p, client := node.Presentation.Value.(*HIRClientPresentation)
					body, reference := node.Body.Value.(*HIRReferenceBody)
					if !client || !reference {
						continue
					}
					var call *HIRCallDisclosure
					if long {
						context, ok := p.Disclosure.Value.(*HIRClientContextDisclosure)
						if !ok || context.Call == nil {
							t.Fatalf("lost composed controls: %+v", p.Disclosure)
						}
						call = context.Call
						if r := context.ExpandedRecursive; r == nil || r.Label != context.Expanded.Label || !reflect.DeepEqual(r.Sections, context.Expanded.Sections) || r.AriaLabel != HIRText("Recursive call "+string(context.Expanded.Label)) {
							t.Fatalf("lost expanded recursive presentation: %+v", r)
						}
						if context.OccurrenceKey == call.OccurrenceKey || !strings.HasSuffix(context.OccurrenceKey, "/context") || !strings.Contains(string(context.Expanded.Label), host) || !strings.Contains(string(context.Collapsed.Label), "…") {
							t.Fatalf("invalid independent context: %+v", context)
						}
					} else {
						call, _ = p.Disclosure.Value.(*HIRCallDisclosure)
					}
					if call == nil || call.OccurrenceKey != body.Reference.OccurrenceKey || call.OccurrenceKey != node.OccurrenceKey+"/expand" {
						t.Fatalf("lost call metadata: %+v", node)
					}
					left, _ := json.Marshal(call.Availability)
					right, _ := json.Marshal(body.Reference.Availability)
					if string(left) != string(right) {
						t.Fatal("call availability disagrees with body")
					}
					if missing, ok := call.Availability.Value.(*HIRUnavailable); ok {
						if missing.Reason == "" {
							t.Fatal("missing unavailable reason")
						}
						unavailable++
					}
					if call.Recursive.Label != p.Label || !reflect.DeepEqual(call.Recursive.Sections, p.Sections) || call.Recursive.Limitation == nil || call.Recursive.Title == "" || call.Recursive.AriaLabel != HIRText("Recursive call "+string(p.Label)) || call.Recursive.Glyph == "" {
						t.Fatalf("lost recursive presentation: %+v", call.Recursive)
					}
					if body.Reference.GraphID == graph.ID {
						recursive++
					} else {
						direct++
					}
				}
			}
			if direct != 2 || recursive != 1 || unavailable != 1 {
				t.Fatalf("calls: direct=%d recursive=%d unavailable=%d", direct, recursive, unavailable)
			}
		})
	}
}

func TestLoweringClientMetadata(t *testing.T) {
	p, items, err := resolveProgram(project(`import ballerina/http;
final http:Client testClient = check new ("https://example.test/this-is-a-long-client-initializer-context-that-requires-the-disclosure-to-retain-its-complete-text");
public function main() returns error? {
 string response = check testClient->get("/orders");
 _ = response;
}
`))
	if err != nil {
		t.Fatal(err)
	}
	if p == nil {
		t.Fatalf("resolve: %+v", items)
	}
	l := &lowerer{p: p}
	if _, err := l.collectFunctions(); err != nil {
		t.Fatal(err)
	}
	if err := l.collectReceiverContexts(); err != nil {
		t.Fatal(err)
	}
	var call ast.Invocable
	for _, mod := range p.modules {
		if !mod.workspace {
			continue
		}
		ast.Walk(sourceVisitor(func(n ast.BLangNode) bool {
			if n, ok := n.(*ast.BLangRemoteMethodCallAction); ok {
				call = n
			}
			return true
		}), mod.pkg)
	}
	if call == nil {
		t.Fatal("missing client call")
	}
	client, err := l.clientPresentation("call", call)
	if err != nil {
		t.Fatal(err)
	}
	if client == nil {
		t.Fatal("missing client presentation")
	}
	presentation := client.presentation.Value.(HIRClientPresentation)
	disclosure, ok := presentation.Disclosure.Value.(HIRClientContextDisclosure)
	if !ok {
		t.Fatalf("missing long initializer disclosure: %+v", presentation)
	}
	if disclosure.OccurrenceKey != "call/context" || !strings.Contains(string(disclosure.Collapsed.Label), "…") || !strings.Contains(string(disclosure.Expanded.Label), "complete-text") {
		t.Fatalf("disclosure: %+v", disclosure)
	}
	if !strings.Contains(string(presentation.Label), "→ get(\"/orders\")") {
		t.Fatalf("client label: %q", presentation.Label)
	}
	if l.sources["call/argument/0"].Text != `"/orders"` {
		t.Fatal("missing original source argument")
	}
}

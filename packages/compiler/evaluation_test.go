package compiler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClientCallAndTemplate(t *testing.T) {
	t.Parallel()
	result, err := Analyze(project("import ballerina/http;\ntype Person record {| string first_name; string last_name; |};\nfinal http:Client testClient = check new (\"https://test.com\");\nservice / on new http:Listener(8080) { resource function get hello() returns string|error { Person person = check testClient->get(\"/foo/bar\"); return string `hello ${person.first_name} ${person.last_name}`; } }"))
	if err != nil || result.Kind != "valid" {
		data, _ := json.Marshal(result.Diagnostics)
		t.Fatalf("%s %v", data, err)
	}
	endpoint := (*result.Program.Scopes[0].Endpoints)[0]
	graph := result.Program.Functions[endpoint.FunctionID]
	_ = hirTestSource(t, result.Program, graph, `Person person = check testClient->get("/foo/bar");`)
	labels := hirTestLabels(graph)
	for _, want := range []string{"Person person", "check", "testClient · http:Client", `check new ("https://test.com")`, `→ get("/foo/bar")`, "person.first_name", "person.last_name", "hello "} {
		if !strings.Contains(labels, want) {
			t.Fatalf("missing evaluation fact %q: %s", want, labels)
		}
	}
	foundTemplate := false
	for _, node := range graph.Nodes {
		if p, ok := node.Presentation.Value.(HIRPlainPresentation); ok && p.Style == HIRNodeStyleTemplate {
			foundTemplate = true
		}
	}
	if !foundTemplate {
		t.Fatal("missing template evaluation")
	}
}

func TestGenericClientContexts(t *testing.T) {
	t.Parallel()
	source := `client class Queue {
   public function init(string host, int port = 12) { _ = host; _ = port; }
   remote function send(string message, string topic = "jobs") returns string|error { return topic + message; }
 }
 final Queue globalQueue = new ("host", port = 99);
 function makeQueue() returns Queue { return new ("factory"); }
 function run(Queue inputQueue) returns error? {
   string first = check globalQueue->send("one", topic = "orders");
   Queue local = makeQueue();
   string second = check local->send("two");
   local = new ("replacement");
   string third = check local->send("three");
   string fourth = check inputQueue->send("four");
 _ = first; _ = second; _ = third; _ = fourth;
   { Queue globalQueue = new ("shadow"); string fifth = check globalQueue->send("five"); _ = fifth; }
 }
 public function main() {}`
	result, err := Analyze(project(source))
	if err != nil || result.Kind != "valid" {
		data, _ := json.Marshal(result.Diagnostics)
		t.Fatalf("%s %v", data, err)
	}
	var graph HIRGraph
	for _, f := range result.Program.Functions {
		if f.Entry.Name == "run" {
			graph = f
		}
	}
	clients := []HIRClientPresentation{}
	for _, node := range graph.Nodes {
		if p, ok := node.Presentation.Value.(HIRClientPresentation); ok {
			clients = append(clients, p)
		}
	}
	if len(clients) != 5 {
		t.Fatalf("client evaluations: %+v", clients)
	}
	for i, wants := range [][]string{
		{`→ send("one", topic = "orders")`, `new ("host", port = 99)`},
		{"Initialization not statically known", `→ send("two")`},
		{"Initialization not statically known", `→ send("three")`},
		{"Parameter", `→ send("four")`},
		{`new ("shadow")`, `→ send("five")`},
	} {
		for _, want := range wants {
			if !strings.Contains(string(clients[i].Label), want) {
				t.Fatalf("context %d missing %q: %+v", i, want, clients[i])
			}
		}
	}
}

func TestNestedErrorOperators(t *testing.T) {
	t.Parallel()
	result, err := Analyze(project(`function risky() returns int|error { return 1; }
 public function main() returns error? {
   int|error captured = trap checkpanic risky();
   int checked = check (trap risky());
   string message = string ` + "`value ${check risky()}`" + `;
 _ = captured; _ = checked; _ = message;
 }`))
	if err != nil || result.Kind != "valid" {
		data, _ := json.Marshal(result.Diagnostics)
		t.Fatalf("%s %v", data, err)
	}
	for _, f := range result.Program.Functions {
		if f.Entry.Name != "main" {
			continue
		}
		// HIR flattens check operands into execution edges, but trap owns its
		// operand group. Check both representations, not just operator labels.
		node := func(path, text, label string, style HIRNodeStyle) HIRNode {
			t.Helper()
			for _, n := range f.Nodes {
				if n.OccurrenceKey != "/"+f.ID+"/statement/"+path {
					continue
				}
				p, ok := n.Presentation.Value.(HIRPlainPresentation)
				if !ok || p.Label != HIRText(label) || p.Style != style || result.Program.Sources[n.SourceID].Text != text {
					t.Fatalf("operator node %s: %+v, source %+v", path, n, result.Program.Sources[n.SourceID])
				}
				return n
			}
			t.Fatalf("missing operator node %s", path)
			return HIRNode{}
		}
		port := func(n HIRNode, role HIRPortRole) string {
			t.Helper()
			for _, p := range f.Ports {
				if p.NodeID == n.ID && p.Role == role {
					return p.ID
				}
			}
			t.Fatalf("missing %s port on %s", role, n.ID)
			return ""
		}
		edge := func(from HIRNode, fromRole HIRPortRole, to HIRNode, toRole HIRPortRole, kind HIREdgeKind) {
			t.Helper()
			a, b := port(from, fromRole), port(to, toRole)
			for _, e := range f.Edges {
				if e.FromPort == a && e.ToPort == b && e.Kind == kind {
					return
				}
			}
			t.Fatalf("missing %s edge %s -> %s", kind, a, b)
		}
		group := func(owner HIRNode, members []HIRNode, columns bool) {
			t.Helper()
			body, ok := owner.Body.Value.(HIRGroupBody)
			if !ok {
				t.Fatalf("operator %s does not own a group", owner.ID)
			}
			for _, g := range f.Groups {
				if g.ID != body.GroupID {
					continue
				}
				var ids []string
				if columns {
					a, ok := g.Arrangement.Value.(HIRColumnsArrangement)
					if !ok || len(a.Left) != 0 {
						t.Fatalf("operator branches: %+v", g)
					}
					ids = a.Right
				} else {
					a, ok := g.Arrangement.Value.(HIRSequenceArrangement)
					if !ok {
						t.Fatalf("trap operand group: %+v", g)
					}
					ids = a.Members
				}
				if len(ids) != len(members) {
					t.Fatalf("operator members: %v", ids)
				}
				for i, member := range members {
					if ids[i] != member.ID {
						t.Fatalf("operator child %d: %s, want %s", i, ids[i], member.ID)
					}
				}
				return
			}
			t.Fatalf("missing owned group %s", body.GroupID)
		}
		trap := node("0/evaluation", "trap checkpanic risky()", "trap", HIRNodeStyleTrap)
		panicCheck := node("0/evaluation/part/0", "checkpanic risky()", "checkpanic", HIRNodeStyleCondition)
		panicExit := node("0/evaluation/part/0/error", "checkpanic risky()", "Panic with error", HIRNodeStylePanic)
		capture := node("0/evaluation/capture", "trap checkpanic risky()", "Capture panic as error value", HIRNodeStyleStep)
		call0 := node("0/evaluation/part/0/part/0", "risky()", "risky()", HIRNodeStyleFunction)
		group(trap, []HIRNode{call0, panicCheck, capture}, false)
		group(panicCheck, []HIRNode{panicExit}, true)
		edge(trap, HIRPortRoleEntry, call0, HIRPortRoleEntry, HIREdgeKindSequence)
		edge(call0, HIRPortRoleNormalExit, panicCheck, HIRPortRoleEntry, HIREdgeKindSequence)
		edge(panicCheck, HIRPortRoleFalse, panicExit, HIRPortRoleEntry, HIREdgeKindError)
		edge(panicExit, HIRPortRolePanic, capture, HIRPortRoleEntry, HIREdgeKindPanic)
		innerTrap := node("1/evaluation/part/0", "trap risky()", "trap", HIRNodeStyleTrap)
		innerCapture := node("1/evaluation/part/0/capture", "trap risky()", "Capture panic as error value", HIRNodeStyleStep)
		call1 := node("1/evaluation/part/0/part/0", "risky()", "risky()", HIRNodeStyleFunction)
		check := node("1/evaluation", "check (trap risky())", "check", HIRNodeStyleCondition)
		return1 := node("1/evaluation/error", "check (trap risky())", "Return error", HIRNodeStyleReturn)
		group(innerTrap, []HIRNode{call1, innerCapture}, false)
		group(check, []HIRNode{return1}, true)
		edge(innerTrap, HIRPortRoleNormalExit, check, HIRPortRoleEntry, HIREdgeKindSequence)
		templateCheck := node("2/evaluation/part/0", "check risky()", "check", HIRNodeStyleCondition)
		return2 := node("2/evaluation/part/0/error", "check risky()", "Return error", HIRNodeStyleReturn)
		call2 := node("2/evaluation/part/0/part/0", "risky()", "risky()", HIRNodeStyleFunction)
		templateText := "string `value ${check risky()}`"
		template := node("2/evaluation", templateText, templateText, HIRNodeStyleTemplate)
		group(templateCheck, []HIRNode{return2}, true)
		edge(call2, HIRPortRoleNormalExit, templateCheck, HIRPortRoleEntry, HIREdgeKindSequence)
		edge(templateCheck, HIRPortRoleNormalExit, template, HIRPortRoleEntry, HIREdgeKindSequence)
		for i, pair := range [][2]HIRNode{{call0, capture}, {call1, innerCapture}} {
			ref, ok := pair[0].Body.Value.(HIRReferenceBody)
			if !ok {
				t.Fatalf("operand %d is not a reference", i)
			}
			caught := false
			for _, binding := range ref.Reference.Inline {
				if b, ok := binding.Value.(HIRExitBinding); ok && b.TargetInterfaceID == "panics" {
					if b.CallerPortID != port(pair[1], HIRPortRoleEntry) || b.Edge.Kind != HIREdgeKindPanic {
						t.Fatalf("trap %d panic binding: %+v", i, b)
					}
					caught = true
				}
			}
			if !caught {
				t.Fatalf("trap %d does not catch expanded operand panics", i)
			}
		}
		// Only the two check operators return errors; checkpanic is caught by
		// the outer trap rather than being exposed as a function return.
		foundReturns := false
		for _, iface := range f.Interfaces {
			if iface.ID == "returns" {
				foundReturns = true
				if len(iface.Members) != 2 || iface.Members[0].PortID != port(return1, HIRPortRoleReturn) || iface.Members[1].PortID != port(return2, HIRPortRoleReturn) {
					t.Fatalf("operator return interface: %+v", iface)
				}
			}
		}
		if !foundReturns {
			t.Fatal("missing operator return interface")
		}
	}
}

func TestClientAssignmentRetainsComputedTarget(t *testing.T) {
	t.Parallel()
	result, err := Analyze(project(`client class Queue {
 remote function read() returns string|error { return "value"; }
 }
 function index() returns int { return 0; }
 function fill(Queue queue, string[] values) returns error? {
 values[index()] = check queue->read();
 }
 public function main() {}`))
	if err != nil || result.Kind != "valid" {
		data, _ := json.Marshal(result.Diagnostics)
		t.Fatalf("%s %v", data, err)
	}
	for _, fn := range result.Program.Functions {
		if fn.Entry.Name != "fill" {
			continue
		}
		calls := hirTestReferences(fn)
		if len(calls) != 2 {
			t.Fatalf("computed target and client calls: %+v", calls)
		}
		if result.Program.Functions[calls[0].Reference.GraphID].Entry.Name != "index" {
			t.Fatalf("computed target call: %+v", calls[0])
		}
		for _, want := range []string{"values[index()]", "check", "queue"} {
			if !strings.Contains(hirTestLabels(fn), want) {
				t.Fatalf("assignment missing %q", want)
			}
		}
	}
}

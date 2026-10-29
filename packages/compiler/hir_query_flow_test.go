package compiler

import "testing"

func TestHIRQueryContinuation(t *testing.T) {
	program := variableProgram(t, `function demo(int[] values) returns int[] {
 int[] result = from int value in values select value;
 result = from int value in result select value + 1;
 return from int value in result select value;
}`)
	for _, graph := range program.Functions {
		if graph.Entry.Name != "demo" {
			continue
		}
		// Three source statements plus the function root; no clause nodes.
		if len(graph.Nodes) != 4 {
			t.Fatalf("unexpected query graph node count: %d", len(graph.Nodes))
		}
		ports := map[string]HIRPort{}
		for _, port := range graph.Ports {
			ports[port.ID] = port
		}
		for i := 0; i < 2; i++ {
			connected := false
			for _, edge := range graph.Edges {
				from, to := ports[edge.FromPort], ports[edge.ToPort]
				if from.NodeID == graph.Nodes[i].ID && from.Role == HIRPortRoleNormalExit && to.NodeID == graph.Nodes[i+1].ID && to.Role == HIRPortRoleEntry {
					connected = true
				}
			}
			if !connected {
				t.Fatalf("query statement %d lost its continuation", i)
			}
		}
		returned := false
		for _, port := range graph.Ports {
			if port.NodeID == graph.Nodes[2].ID && port.Role == HIRPortRoleReturn {
				returned = true
			}
		}
		if !returned {
			t.Fatal("query return lost its return port")
		}
		return
	}
	t.Fatal("demo graph missing")
}

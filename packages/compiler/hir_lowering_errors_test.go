package compiler

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

// Compile-time checks intentionally name the FINAL private construction API.
var (
	_ func(*graphBuilder, string, ast.StatementNode) (fragment, error)                              = (*graphBuilder).lowerStatement
	_ func(*graphBuilder, string, ast.BLangActionOrExpression, evaluationContext) (fragment, error) = (*graphBuilder).lowerExpression
	_ func(*graphBuilder, string, ast.Invocable, evaluationContext) (fragment, error)               = (*graphBuilder).lowerCall
	_ func(*graphBuilder, HIRNode) error                                                            = (*graphBuilder).addNode
	_ func(*graphBuilder, HIRPort) error                                                            = (*graphBuilder).addPort
	_ func(*graphBuilder, HIREdge) error                                                            = (*graphBuilder).addEdge
	_ func(*graphBuilder) (HIRGraph, error)                                                         = (*graphBuilder).finish
)

func TestLoweringConstructionPrimitives(t *testing.T) {
	b := &graphBuilder{}
	node := HIRNode{ID: "node"}
	if err := b.addNode(node); err != nil {
		t.Fatal(err)
	}
	if err := b.addNode(node); err == nil {
		t.Fatal("duplicate node accepted")
	}
	if err := b.addNode(HIRNode{}); err == nil {
		t.Fatal("empty node accepted")
	}
	if err := b.addPort(HIRPort{ID: "bad", NodeID: "missing"}); err == nil {
		t.Fatal("missing node accepted")
	}
	port := HIRPort{ID: "port", NodeID: "node"}
	if err := b.addPort(port); err != nil {
		t.Fatal(err)
	}
	if err := b.addPort(port); err == nil {
		t.Fatal("duplicate port accepted")
	}
	if err := b.addPort(HIRPort{NodeID: "node"}); err == nil {
		t.Fatal("empty port accepted")
	}
	for _, edge := range []HIREdge{{ID: "bad", FromPort: "port", ToPort: "missing"}, {ID: "bad", FromPort: "missing", ToPort: "port"}, {FromPort: "port", ToPort: "port"}} {
		if err := b.addEdge(edge); err == nil {
			t.Fatal("invalid edge accepted")
		}
	}
	edge := HIREdge{ID: "edge", FromPort: "port", ToPort: "port", When: present()}
	if err := b.addEdge(edge); err != nil {
		t.Fatal(err)
	}
	if err := b.addEdge(edge); err == nil {
		t.Fatal("duplicate edge accepted")
	}
	if len(b.graph.Nodes) != 1 || len(b.graph.Ports) != 1 || len(b.graph.Edges) != 1 {
		t.Fatal("rejected primitive mutated construction tables")
	}
}

func TestLoweringConstructionErrorBoundaries(t *testing.T) {
	first := errors.New("first construction error")
	b := &graphBuilder{}
	b.recordError(first)
	b.recordError(errors.New("later error"))
	// Nil source inputs prove the retained construction error wins before any
	// frontend access; every required lowering boundary is safe independently.
	checks := []struct {
		name string
		run  func() error
	}{
		{"statement", func() error { _, err := b.lowerStatement("path", nil); return err }},
		{"expression", func() error { _, err := b.lowerExpression("path", nil, evaluationContext{}); return err }},
		{"call", func() error { _, err := b.lowerCall("path", nil, evaluationContext{}); return err }},
		{"finish", func() error { _, err := b.finish(); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.run(); !errors.Is(err, first) {
				t.Fatalf("lost first error: %v", err)
			}
		})
	}
	// An ergonomic allocator must capture an actual primitive failure too.
	b = &graphBuilder{}
	b.allocNode("duplicate", "occ", "source", plain(HIRNodeStyleStep, "first"))
	b.allocNode("duplicate", "occ", "source", plain(HIRNodeStyleStep, "second"))
	if _, err := b.finish(); err == nil || !strings.Contains(err.Error(), "duplicate node") {
		t.Fatalf("allocator failure lost: %v", err)
	}
	b = &graphBuilder{}
	b.allocPort("missing", HIRPortRoleEntry)
	if _, err := b.finish(); err == nil {
		t.Fatal("missing node panicked or error lost")
	}
}

func TestLoweringPropagatesNewConstructionErrors(t *testing.T) {
	l, fn := errorTestLowerer(t, "function value() returns int { return 1; } function main() returns int { return value(); }")
	statement := fn.node.GetBody().(*ast.BLangBlockFunctionBody).Stmts[0]
	id := fn.id + "/statement/0"
	newBuilder := func() *graphBuilder {
		return &graphBuilder{l: l, graph: HIRGraph{LocatedModel: LocatedModel{ID: fn.id}}}
	}
	t.Run("statement", func(t *testing.T) {
		b := newBuilder()
		if _, err := b.lowerStatementAt(id, "occ", statement); err != nil {
			t.Fatal(err)
		}
		if _, err := b.lowerStatementAt(id, "occ", statement); err == nil {
			t.Fatal("new duplicate error not propagated")
		}
	})
	expr := statement.(*ast.BLangReturn).Expr
	t.Run("expression", func(t *testing.T) {
		b := newBuilder()
		context := evaluationContext{sourceID: id + "/expression", force: true}
		if _, err := b.lowerExpression("occ", expr, context); err != nil {
			t.Fatal(err)
		}
		if _, err := b.lowerExpression("occ", expr, context); err == nil {
			t.Fatal("new duplicate error not propagated")
		}
	})
	t.Run("call", func(t *testing.T) {
		b := newBuilder()
		call := expr.(ast.Invocable)
		context := evaluationContext{kind: evaluationCall, nodeID: "missing", call: directCall{node: call}}
		if _, err := b.lowerCall("occ", call, context); err == nil {
			t.Fatal("missing call node not propagated")
		}
	})
	t.Run("finish", func(t *testing.T) {
		b := newBuilder()
		b.allocNode(fn.id+"/root", "occ", fn.id, plain(HIRNodeStyleStep, "duplicate root"))
		if _, err := b.finish(); err == nil {
			t.Fatal("new root construction error not propagated")
		}
	})
}

func errorTestLowerer(t *testing.T, source string) (*lowerer, sourceFunctionEntry) {
	t.Helper()
	p, diagnostics, err := resolveProgram(project(source))
	if err != nil || p == nil {
		t.Fatalf("resolve: %v: %+v", err, diagnostics)
	}
	l := &lowerer{p: p}
	functions, err := l.collectFunctions()
	if err != nil {
		t.Fatal(err)
	}
	for _, fn := range functions {
		if fn.node.GetName().GetValue() == "main" {
			return l, fn
		}
	}
	t.Fatal("missing main")
	return nil, sourceFunctionEntry{}
}

func TestLoweringReturnPortPresence(t *testing.T) {
	for _, body := range []string{"{ return dead(); }", "=> dead();"} {
		t.Run(body, func(t *testing.T) {
			l, fn := errorTestLowerer(t, "function dead() returns int { panic error(\"stop\"); } function main() returns int "+body)
			graph, err := l.lowerFunction(fn)
			if err != nil {
				t.Fatal(err)
			}
			// Evaluate only the generic continuation query: a collapsed call
			// continues, while the expanded panic-only callee does not.
			var evaluate func(HIRPresence, bool) bool
			evaluate = func(p HIRPresence, continuation bool) bool {
				switch v := p.Value.(type) {
				case HIRConstantPresence:
					return v.Value
				case HIRNonemptyPresence:
					if v.InterfaceID == "entry" {
						return true
					}
					if v.InterfaceID == "returns" {
						return false
					}
					return continuation
				case HIRNotPresence:
					return !evaluate(v.Operand, continuation)
				case HIRAllPresence:
					for _, child := range v.Operands {
						if !evaluate(child, continuation) {
							return false
						}
					}
					return true
				case HIRAnyPresence:
					for _, child := range v.Operands {
						if evaluate(child, continuation) {
							return true
						}
					}
					return false
				default:
					t.Fatalf("unexpected presence %T", p.Value)
					return false
				}
			}
			count := 0
			for _, port := range graph.Ports {
				if port.Role != HIRPortRoleReturn {
					continue
				}
				count++
				for _, plan := range []HIREmissionPlan{graph.Emission.Root, graph.Emission.Inline} {
					found := false
					for _, slot := range plan.Ports {
						local, ok := slot.Value.(HIRLocalEmission)
						if !ok || local.ItemID != port.ID {
							continue
						}
						found = true
						if !evaluate(local.When, true) || evaluate(local.When, false) {
							t.Fatal("return port must follow callee continuation")
						}
						for _, face := range graph.Interfaces {
							for _, member := range face.Members {
								if member.PortID != port.ID {
									continue
								}
								// The member includes its own unconditional guard.
								if !evaluate(member.When, true) || evaluate(member.When, false) {
									t.Fatal("return interface must follow callee continuation")
								}
							}
						}
					}
					if !found {
						t.Fatal("missing return port emission")
					}
				}
			}
			if count != 1 {
				t.Fatalf("return ports: %d", count)
			}
		})
	}
}

func TestLoweringEmptyNestedBlocks(t *testing.T) {
	for _, body := range []string{
		"{} _ = 1;",
		"{{}} _ = 1;",
		"_ = 1; {} _ = 2;",
		"_ = 1; {{}}",
		"return; {} _ = 1;",
	} {
		t.Run(body, func(t *testing.T) {
			l, fn := errorTestLowerer(t, "public function main() {"+body+"}")
			b := &graphBuilder{l: l, ports: map[string]bool{}}
			statements := fn.node.GetBody().(*ast.BLangBlockFunctionBody).Stmts
			f, err := b.lowerBlock(fn.id, statements)
			if err != nil {
				t.Fatal(err)
			}
			if len(f.nodes) == 0 || len(f.entry) != 1 {
				t.Fatalf("empty block lost visible entry: %+v", f)
			}
			if f.entry[0].PortID != f.nodes[0]+":entry" {
				t.Fatalf("entry does not reach first visible node: %+v", f.entry)
			}
			wantEdges := 0
			if strings.Contains(body, "= 2") {
				wantEdges = 1
			}
			if len(b.graph.Edges) != wantEdges {
				t.Fatalf("sequence edges: got %d, want %d", len(b.graph.Edges), wantEdges)
			}
			if !strings.Contains(body, "return") && len(f.normal) != 1 {
				t.Fatalf("trailing empty block lost normal completion: %+v", f.normal)
			}
		})
	}
	if !(fragment{}).empty() || (fragment{nodes: []string{"unsupported"}}).empty() || (fragment{returns: member("return")}).empty() {
		t.Fatal("empty fragments must be distinguished from regions without incoming members")
	}
}

func TestLoweringSourceErrorsReturn(t *testing.T) {
	for _, boundary := range []string{"source", "statement", "block", "expression", "expression-return", "scan-calls", "function"} {
		for _, failure := range []string{"identity", "offset"} {
			t.Run(boundary+"/"+failure, func(t *testing.T) {
				l, fn := errorTestLowerer(t, "function value() returns int => 1; public function main() { int a = value(); _ = a; }")
				statement := fn.node.GetBody().(*ast.BLangBlockFunctionBody).Stmts[0]
				expr := statement.(*ast.BLangVariableDef).Var.Expr
				id := "test"
				conflictID := id
				if boundary == "block" {
					conflictID += "/statement/0"
				}
				if boundary == "function" {
					conflictID = fn.id + "/statement/0"
				}
				if boundary == "scan-calls" {
					conflictID += "/call/0"
				}
				if failure == "identity" {
					if _, err := l.located(conflictID, fn.node); err != nil {
						t.Fatal(err)
					}
				} else {
					// The resolved AST keeps its original offsets, but its source
					// document is now too short to contain those ranges.
					for name := range l.p.files {
						l.p.files[name] = ""
					}
				}
				b := &graphBuilder{l: l, ports: map[string]bool{}}
				var err error
				switch boundary {
				case "source":
					_, err = b.source(id, expr)
				case "statement":
					_, err = b.lowerStatementAt(id, id, statement)
				case "block":
					_, err = b.lowerBlock(id, []ast.StatementNode{statement})
				case "expression":
					_, err = b.lowerExpression(id, expr, evaluationContext{sourceID: id})
				case "expression-return":
					_, err = b.lowerExpressionReturn(id, id, expr)
				case "scan-calls":
					_, _, err = b.scanCalls(id, expr, true)
				case "function":
					_, err = l.lowerFunction(fn)
				}
				if err == nil {
					t.Fatal("source error was swallowed")
				}
			})
		}
	}
}

func TestLoweringMalformedForeachHeader(t *testing.T) {
	for _, failure := range []string{"invalid-rune", "past-end", "reversed", "negative", "missing-variable"} {
		t.Run(failure, func(t *testing.T) {
			l, fn := errorTestLowerer(t, `function values() returns int[] => [1]; public function main() { string s = "😀"; foreach int value in values() { _ = value; } _ = s; }`)
			statement := fn.node.GetBody().(*ast.BLangBlockFunctionBody).Stmts[1].(*ast.BLangForeach)
			location := statement.VariableDef.GetPosition()
			file := l.p.env.DiagnosticEnv().FileName(location)
			start := location.StartOffset()
			end := statement.Collection.GetPosition()
			switch failure {
			case "invalid-rune":
				start = strings.Index(l.p.files[file], "😀") + 1
			case "past-end":
				start = len(l.p.files[file]) + 1
			case "reversed":
				start = end.EndOffset() + 1
			case "negative":
				start = -1
			case "missing-variable":
				statement.VariableDef = nil
			}
			if statement.VariableDef != nil {
				statement.VariableDef.SetPosition(diagnostics.NewLocation(l.p.env.DiagnosticEnv(), file, start, location.EndOffset()))
			}
			before, beforeErr := printFrontend(l.p)
			// Malformed offsets may also be rejected by the AST printer. Preserve
			// both its partial dump and error, and compare the raw position too.
			var variablePosition diagnostics.Location
			if statement.VariableDef != nil {
				variablePosition = statement.VariableDef.GetPosition()
			}
			calls, news := hirCloneArgumentMap(l.p.sourceCallArgs), hirCloneArgumentMap(l.p.sourceNewArgs)
			files := Files{}
			for name, text := range l.p.files {
				files[name] = text
			}
			id := fn.id + "/statement/1"
			b := &graphBuilder{l: l, ports: map[string]bool{}}
			if _, err := b.lowerStatementAt(id, id, statement); err == nil {
				t.Fatal("malformed foreach header accepted")
			}
			if _, exists := l.sources[id+"/header"]; exists {
				t.Fatal("malformed header created source metadata")
			}
			after, afterErr := printFrontend(l.p)
			if before != after || fmt.Sprint(beforeErr) != fmt.Sprint(afterErr) || !reflect.DeepEqual(calls, l.p.sourceCallArgs) || !reflect.DeepEqual(news, l.p.sourceNewArgs) || !reflect.DeepEqual(files, l.p.files) {
				t.Fatalf("lowering mutated frontend/provenance: %v", afterErr)
			}
			if statement.VariableDef != nil && statement.VariableDef.GetPosition() != variablePosition {
				t.Fatal("lowering mutated variable source position")
			}
		})
	}
}

func TestLoweringClientErrorsReturn(t *testing.T) {
	for _, boundary := range []string{"helper", "expression", "statement", "function"} {
		t.Run(boundary, func(t *testing.T) {
			l, fn := errorTestLowerer(t, `import ballerina/http;
final http:Client c = check new ("https://example.test");
public function main() returns error? { string response = check c->get("/"); _ = response; }`)
			statement := fn.node.GetBody().(*ast.BLangBlockFunctionBody).Stmts[0]
			expr := statement.(*ast.BLangVariableDef).Var.Expr
			b := &graphBuilder{l: l, ports: map[string]bool{}}
			id := fn.id + "/statement/0"
			calls, _, err := b.scanCalls(id, expr, true)
			if err != nil || len(calls) != 1 {
				t.Fatalf("calls: %+v: %v", calls, err)
			}
			// Receiver provenance errors arise after call scanning succeeds.
			if _, err := l.located(calls[0].id+"/receiver", fn.node); err != nil {
				t.Fatal(err)
			}
			switch boundary {
			case "helper":
				_, err = b.clientPresentation(&calls[0], "occurrence")
			case "expression":
				_, err = b.lowerExpression("occurrence", expr, evaluationContext{sourceID: id + "/value", calls: calls})
			case "statement":
				_, err = b.lowerStatementAt(id, "occurrence", statement)
			case "function":
				_, err = l.lowerFunction(fn)
			}
			if err == nil || !strings.Contains(err.Error(), "conflicting source identity") {
				t.Fatalf("expected client provenance error, got %v", err)
			}
		})
	}
}

package compiler

// Private test-data adapter. These archived ProgramModels are synthetic graphs,
// not ASTs. Only graphBuilder's generic node/port/edge/reference operations are
// reused; no frontend nodes, source parsing, or legacy diagram builder is used.
import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type syntheticHIRBuilder struct {
	b       *graphBuilder
	sources HIRRecord[LocatedModel]
	program ProgramModel
}

func (s *syntheticHIRBuilder) located(v LocatedModel) string { s.sources[v.ID] = v; return v.ID }
func (s *syntheticHIRBuilder) node(path string, source LocatedModel, style HIRNodeStyle, label string) string {
	return s.b.allocNode(path, strings.TrimPrefix(path, s.b.graph.ID), s.located(source), plain(style, label))
}
func syntheticStatements(p *[]StatementModel) []StatementModel {
	if p == nil {
		return nil
	}
	return *p
}
func (s *syntheticHIRBuilder) block(items []StatementModel, path string) fragment {
	f := fragment{}
	var previous []HIRInterfaceMember
	for i, v := range items {
		p := s.statement(v, path+"/"+v.ID)
		if i == 0 {
			f.entry = p.entry
		}
		s.b.connect(previous, p.entry, HIREdgeKindSequence)
		previous = p.normal
		f.nodes = append(f.nodes, p.nodes...)
		f.returns = append(f.returns, p.returns...)
		f.breaks = append(f.breaks, p.breaks...)
		f.continues = append(f.continues, p.continues...)
		appendPanics(&f, p)
	}
	f.normal = previous
	return f
}
func (s *syntheticHIRBuilder) call(node, path string, c CallSiteModel, evaluation bool) []HIRInterfaceMember {
	s.located(c.LocatedModel)
	target := c.Target.FunctionID
	supported := c.Expansion == "supported"
	reason := c.Reason
	if _, ok := s.program.Functions[target]; !ok {
		supported = false
		if reason == "" {
			reason = "Function body is unavailable."
		}
	}
	normal := s.b.bindCallReference(node, path, directCall{target: target, supported: supported, reason: reason}, evaluation)
	// Synthetic tests pin the original accessible label independently from the
	// limitation/title text; the runtime must not reconstruct either from source.
	if p, ok := s.b.node(node).Presentation.Value.(HIRPlainPresentation); ok {
		if d, ok := p.Disclosure.Value.(HIRCallDisclosure); ok {
			d.Recursive.AriaLabel = HIRText("Recursive call " + string(p.Label))
			p.Disclosure.Value = d
			s.b.node(node).Presentation.Value = p
		}
	}
	return normal
}
func (s *syntheticHIRBuilder) statement(v StatementModel, path string) fragment {
	b := s.b
	source := v.LocatedModel
	label := v.Text
	style := HIRNodeStyleStep
	switch v.Kind {
	case "return":
		style = HIRNodeStyleReturn
	case "if", "while":
		source = v.Condition.LocatedModel
		label = source.Text
	case "foreach":
		source = v.Header.LocatedModel
		label = "foreach " + source.Text
	case "unsupported":
		style = HIRNodeStyleUnsupported
	}
	if v.Kind == "if" {
		style = HIRNodeStyleCondition
	}
	if v.Kind == "while" || v.Kind == "foreach" {
		style = HIRNodeStyleLoop
	}
	if v.Presentation == "mapping" {
		style = HIRNodeStyleMapping
	}
	node := s.node(path, source, style, label)
	entry := b.allocPort(node, HIRPortRoleEntry)
	f := fragment{nodes: []string{node}, entry: member(entry)}
	if v.Kind == "unsupported" {
		p := b.node(node).Presentation.Value.(HIRPlainPresentation)
		p.Limitation = &v.Reason
		b.node(node).Presentation.Value = p
		return f
	}
	evaluation := v.Evaluation
	if evaluation == nil && v.Condition != nil {
		evaluation = v.Condition.Evaluation
	}
	if evaluation == nil && v.Header != nil {
		evaluation = v.Header.Evaluation
	}
	if evaluation != nil {
		e := s.evaluate(*evaluation, path+"/evaluation")
		b.connect(e.normal, member(entry), HIREdgeKindSequence)
		f.entry = e.entry
		if len(f.entry) == 0 {
			f.entry = member(entry)
		}
		f.nodes = append(e.nodes, f.nodes...)
		f.returns = e.returns
		appendPanics(&f, e)
		if v.Kind == "simple" || v.Kind == "return" {
			p := b.node(node).Presentation.Value.(HIRPlainPresentation)
			if v.Kind == "return" {
				p.Label = "Return value"
			} else if v.Binding != "" {
				p.Label = HIRText("Result → " + v.Binding)
			}
			b.node(node).Presentation.Value = p
			if v.Kind == "return" {
				f.returns = append(f.returns, member(b.allocPort(node, HIRPortRoleReturn))...)
			} else {
				f.normal = member(b.allocPort(node, HIRPortRoleNormalExit))
			}
			return f
		}
	}
	switch v.Kind {
	case "break":
		f.breaks = member(b.allocPort(node, HIRPortRoleBreak))
		return f
	case "continue":
		f.continues = member(b.allocPort(node, HIRPortRoleContinue))
		return f
	case "if":
		a := s.block(syntheticStatements(v.ThenBody), path+"/then")
		c := s.block(syntheticStatements(v.ElseBody), path+"/else")
		join := b.allocPort(node, HIRPortRoleNormalExit)
		ae := a.entry
		if len(ae) == 0 {
			ae = member(join)
		}
		ce := c.entry
		if len(ce) == 0 {
			ce = member(join)
		}
		b.connect(member(b.allocPort(node, HIRPortRoleTrue)), ae, HIREdgeKindTrue)
		b.connect(member(b.allocPort(node, HIRPortRoleFalse)), ce, HIREdgeKindFalse)
		b.connect(a.normal, member(join), HIREdgeKindSequence)
		b.connect(c.normal, member(join), HIREdgeKindSequence)
		if !(len(a.entry) > 0 && len(c.entry) > 0 && len(a.normal) == 0 && len(c.normal) == 0) {
			f.normal = member(join)
		}
		f.returns = append(f.returns, append(a.returns, c.returns...)...)
		f.breaks = append(a.breaks, c.breaks...)
		f.continues = append(a.continues, c.continues...)
		appendPanics(&f, a)
		appendPanics(&f, c)
		b.group(node, HIRSpacingProfileIf, a.nodes, c.nodes, true)
		return f
	case "while", "foreach":
		body := s.block(syntheticStatements(v.Body), path+"/loop")
		exit := b.allocPort(node, HIRPortRoleNormalExit)
		f.normal = member(exit)
		iteration := f.entry
		kind := HIREdgeKindTrue
		back := HIREdgeKindBack
		if v.Kind == "foreach" {
			iteration = member(b.allocPort(node, HIRPortRoleNextIteration))
			kind = HIREdgeKindSequence
			back = HIREdgeKindSequence
		}
		target := body.entry
		if len(target) == 0 {
			target = iteration
		}
		b.connect(member(b.allocPort(node, HIRPortRoleTrue)), target, kind)
		if v.Kind == "while" {
			b.connect(member(b.allocPort(node, HIRPortRoleFalse)), member(exit), HIREdgeKindFalse)
		}
		b.connect(body.normal, iteration, back)
		beforeContinue := len(b.graph.Edges)
		b.connect(body.continues, iteration, HIREdgeKindContinue)
		if v.Kind == "foreach" {
			for i := beforeContinue; i < len(b.graph.Edges); i++ {
				b.graph.Edges[i].Routing = HIRRoutingDirect
			}
		}
		b.connect(body.breaks, member(exit), HIREdgeKindBreak)
		f.returns = append(f.returns, body.returns...)
		appendPanics(&f, body)
		profile := HIRSpacingProfileWhile
		if v.Kind == "foreach" {
			profile = HIRSpacingProfileForeach
		}
		b.group(node, profile, body.nodes, nil, false)
		return f
	}
	normal := member(b.allocPort(node, HIRPortRoleNormalExit))
	children := []string{}
	if v.Calls != nil {
		for _, c := range *v.Calls {
			if c.Target.Kind == "external" {
				continue
			}
			cp := path + "/expand/" + c.ID
			cn := s.node(cp, c.LocatedModel, HIRNodeStyleFunction, c.Text)
			children = append(children, cn)
			if c.Expansion == "supported" {
				b.connect(normal, member(b.allocPort(cn, HIRPortRoleEntry)), HIREdgeKindSequence)
				normal = s.call(cn, cp, c, false)
			} else {
				s.call(cn, cp, c, false)
			}
		}
	}
	if len(children) > 0 {
		b.group(node, HIRSpacingProfileSequence, children, nil, false)
		// An ordinary statement containing call disclosures continues from its
		// header, not the bottom of its children/container.
		for i := range b.graph.Ports {
			if b.graph.Ports[i].NodeID == node && b.graph.Ports[i].Role == HIRPortRoleNormalExit {
				b.graph.Ports[i].Anchor.Kind = HIRAnchorKindHeaderBottomCenter
			}
		}
	}
	if v.Kind == "return" {
		if len(normal) > 0 {
			ret := b.allocPort(node, HIRPortRoleReturn)
			if normal[0].PortID != node+":normal-exit" {
				b.connect(normal, member(ret), HIREdgeKindReturn)
			}
			f.returns = member(ret)
		}
	} else {
		f.normal = normal
	}
	return f
}
func (s *syntheticHIRBuilder) evaluate(v EvaluationModel, path string) fragment {
	b := s.b
	children := v.Children
	if v.Kind == "template" {
		children = nil
		for _, c := range v.Children {
			if c.Kind != "source" || len(c.Children) > 0 {
				children = append(children, c)
			}
		}
	}
	nested := fragment{}
	var previous []HIRInterfaceMember
	for i, c := range children {
		p := s.evaluate(c, fmt.Sprintf("%s/part/%d", path, i))
		if i == 0 {
			nested.entry = p.entry
		}
		b.connect(previous, p.entry, HIREdgeKindSequence)
		previous = p.normal
		nested.nodes = append(nested.nodes, p.nodes...)
		nested.returns = append(nested.returns, p.returns...)
		appendPanics(&nested, p)
	}
	nested.normal = previous
	if v.Kind == "check" || v.Kind == "checkpanic" {
		style := HIRNodeStyleReturn
		label := "Return error"
		role := HIRPortRoleReturn
		if v.Kind == "checkpanic" {
			style = HIRNodeStylePanic
			label = "Panic with error"
			role = HIRPortRolePanic
		}
		terminal := s.node(path+"/error", v.LocatedModel, style, label)
		node := s.node(path, v.LocatedModel, HIRNodeStyleCondition, v.Kind)
		join := b.allocPort(node, HIRPortRoleNormalExit)
		b.allocEdge(b.allocPort(node, HIRPortRoleTrue), join, HIREdgeKindTrue, "value", present())
		b.allocEdge(b.allocPort(node, HIRPortRoleFalse), b.allocPort(terminal, HIRPortRoleEntry), HIREdgeKindError, "error", present())
		b.connect(nested.normal, member(b.allocPort(node, HIRPortRoleEntry)), HIREdgeKindSequence)
		if len(nested.entry) == 0 {
			nested.entry = member(b.allocPort(node, HIRPortRoleEntry))
		}
		nested.nodes = append(nested.nodes, node)
		nested.normal = member(join)
		if role == HIRPortRoleReturn {
			nested.returns = append(nested.returns, member(b.allocPort(terminal, role))...)
		} else {
			nested.panics = append(nested.panics, member(b.allocPort(terminal, role))...)
		}
		b.group(node, HIRSpacingProfileIf, nil, []string{terminal}, true)
		return nested
	}
	if v.Kind == "trap" {
		capture := s.node(path+"/capture", v.LocatedModel, HIRNodeStyleStep, "Capture panic as error value")
		node := s.node(path, v.LocatedModel, HIRNodeStyleTrap, "trap")
		exit := b.allocPort(node, HIRPortRoleNormalExit)
		target := nested.entry
		if len(target) == 0 {
			target = member(exit)
		}
		b.connect(member(b.allocPort(node, HIRPortRoleEntry)), target, HIREdgeKindSequence)
		b.connect(nested.normal, member(exit), HIREdgeKindSequence)
		for _, p := range nested.panics {
			b.allocEdge(p.PortID, b.allocPort(capture, HIRPortRoleEntry), HIREdgeKindPanic, "panic", p.When)
		}
		for _, p := range nested.panicExports {
			b.catchPanic(p.reference, b.allocPort(capture, HIRPortRoleEntry))
		}
		b.allocEdge(b.allocPort(capture, HIRPortRoleNormalExit), exit, HIREdgeKindSequence, "error value", present())
		b.group(node, HIRSpacingProfileTrap, append(nested.nodes, capture), nil, false)
		return fragment{nodes: []string{node}, entry: member(b.allocPort(node, HIRPortRoleEntry)), normal: member(exit), returns: nested.returns}
	}
	source := v.LocatedModel
	label := v.Text
	style := HIRNodeStyleStep
	if v.Kind == "template" {
		style = HIRNodeStyleTemplate
	}
	if v.Call != nil {
		source = v.Call.LocatedModel
		if v.Call.Target.Kind == "workspace" {
			style = HIRNodeStyleFunction
		}
	}
	node := s.node(path, source, style, label)
	if v.Call != nil && v.Call.Client != nil {
		c := v.Call.Client
		context := "Initialization not statically known"
		if c.Context.Initializer != nil {
			context = c.Context.Initializer.Text
		} else if c.Context.Origin == "parameter" {
			context = "Parameter"
		}
		receiver := c.Context.Receiver.Text
		if c.Context.Type != "" {
			receiver += " · " + c.Context.Type
		}
		method := c.Method
		if !strings.HasPrefix(method, "->") {
			args := []string{}
			for _, a := range c.Arguments {
				args = append(args, a.Text)
			}
			method = "→ " + method + "(" + strings.Join(args, ", ") + ")"
		}
		summary := context
		if len([]rune(summary)) > 90 {
			summary = string([]rune(summary)[:87]) + "…"
		}
		content := func(ctx string) HIRLabelContent {
			return HIRLabelContent{Label: HIRText(receiver + "\n" + ctx + "\n" + method), Sections: HIRList[HIRLabelSection]{{Kind: HIRLabelSectionKindReceiver, Text: HIRText(receiver)}, {Kind: HIRLabelSectionKindContext, Text: HIRText(ctx)}, {Kind: HIRLabelSectionKindMethod, Text: HIRText(method)}}}
		}
		collapsed := content(summary)
		expanded := content(context)
		d := HIRDisclosure{Value: HIRNoDisclosure{}}
		if summary != context {
			d = HIRDisclosure{Value: HIRClientContextDisclosure{OccurrenceKey: strings.TrimPrefix(path+"/context", b.graph.ID), Collapsed: collapsed, Expanded: expanded}}
		}
		b.node(node).Presentation.Value = HIRClientPresentation{Style: HIRClientStyleClient, Label: collapsed.Label, Sections: collapsed.Sections, Disclosure: d}
	}
	entry := b.allocPort(node, HIRPortRoleEntry)
	b.connect(nested.normal, member(entry), HIREdgeKindSequence)
	if len(nested.entry) == 0 {
		nested.entry = member(entry)
	}
	nested.nodes = append(nested.nodes, node)
	nested.normal = member(b.allocPort(node, HIRPortRoleNormalExit))
	nested.panics = append(nested.panics, member(b.allocPort(node, HIRPortRolePanic))...)
	if v.Call != nil && v.Call.Target.Kind == "workspace" {
		nested.normal = s.call(node, path+"/expand", *v.Call, true)
		nested.panicExports = append(nested.panicExports, panicExport{reference: node, before: len(nested.panics)})
	}
	return nested
}

func TestHIRSyntheticFixtures(t *testing.T) {
	data, err := os.ReadFile("testdata/upstream/tests/fixtures/flow-rendering/inputs/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]struct {
		Kind      string          `json:"kind"`
		Program   json.RawMessage `json:"program"`
		GraphOnly bool            `json:"graphOnly"`
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for id, c := range catalog {
		if c.Kind == "synthetic" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			c := catalog[id]
			var model ProgramModel
			if err := json.Unmarshal(c.Program, &model); err != nil {
				t.Fatal(err)
			}
			// Genuine compiler models used by stale-analysis scenarios retain direct HIR.
			var hir HIRProgram
			direct := false
			for _, p := range readHIRCorpus(t) {
				if p.HIR == nil {
					continue
				}
				snapshot, e := os.ReadFile(filepath.Join(hirProjectsRoot, p.Directory, "legacy-model.json"))
				if e != nil {
					t.Fatal(e)
				}
				var candidate any
				var original any
				json.Unmarshal(snapshot, &candidate)
				json.Unmarshal(c.Program, &original)
				if reflect.DeepEqual(candidate, original) {
					raw, e := os.ReadFile(filepath.Join(hirProjectsRoot, p.Directory, *p.HIR))
					if e != nil {
						t.Fatal(e)
					}
					if e = json.Unmarshal(raw, &hir); e != nil {
						t.Fatal(e)
					}
					direct = true
					break
				}
			}
			if !direct {
				hir = HIRProgram{Scopes: model.Scopes, Sources: HIRRecord[LocatedModel]{}, Functions: HIRRecord[HIRGraph]{}}
				names := []string{}
				for name := range model.Functions {
					names = append(names, name)
				}
				sort.Strings(names)
				for _, name := range names {
					fn := model.Functions[name]
					b := &graphBuilder{ports: map[string]bool{}, graph: HIRGraph{LocatedModel: fn.LocatedModel, ModuleID: fn.ModuleID, Entry: HIREntry{Kind: HIREntryKindFunction, Name: fn.Entry.Name, Signature: fn.Entry.Signature, ReturnType: fn.Entry.ReturnType}}}
					s := syntheticHIRBuilder{b: b, sources: hir.Sources, program: model}
					s.located(fn.LocatedModel)
					b.finalFragment = s.block(fn.Body, name)
					graph, err := b.finish()
					if err != nil {
						t.Fatal(err)
					}
					hir.Functions[name] = graph
				}
			}
			// Graph-only inputs honestly omit declaration metadata. The production
			// validator requires real declarations, so only genuine direct HIR is
			// subject to that check; graph-only fixtures retain their explicit omission.
			if direct {
				if err := ValidateHIR(hir); err != nil {
					t.Fatalf("direct synthetic-state graph contract: %v", err)
				}
			}
			fixture := struct {
				CatalogRef    string          `json:"catalogRef"`
				LegacyProgram json.RawMessage `json:"legacyProgram"`
				HIR           HIRProgram      `json:"hir"`
				GraphOnly     bool            `json:"graphOnly"`
				Provenance    string          `json:"provenance"`
			}{id, c.Program, hir, c.GraphOnly, "Archived synthetic graph input; no AST exists or is fabricated. Entry metadata is omitted by graphOnly exactly when the original fixture omitted it."}
			actual, e := json.MarshalIndent(fixture, "", "  ")
			if e != nil {
				t.Fatal(e)
			}
			root := filepath.Join("testdata/upstream/tests/fixtures/hir-synthetic", id)
			path := filepath.Join(root, "fixture.json")
			if *updateHIRGoldens {
				if e = os.MkdirAll(root, 0755); e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(path, append(actual, '\n'), 0644); e != nil {
					t.Fatal(e)
				}
			} else {
				expected, e := os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				if string(expected) != string(append(actual, '\n')) {
					t.Fatal("synthetic HIR fixture differs; explicitly update")
				}
			}
		})
	}
}

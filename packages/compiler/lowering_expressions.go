package compiler

import (
	"fmt"
	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/model"
	"github.com/ballerina-nutcracker/ballerina/semtypes"
	"strings"
)

// evaluationContext is transient, tagged construction input. Source identities
// and render occurrence recipes are explicit and never decoded from each other.
type evaluationContextKind uint8

const (
	evaluationExpression evaluationContextKind = iota
	evaluationStatement
	evaluationCall
)

type evaluationContext struct {
	kind                     evaluationContextKind
	sourceID, occurrencePath string
	calls                    []directCall
	force                    bool
	call                     directCall
	nodeID                   string
	evaluation               bool
	// Constructor-valued arguments are nested presentation, not flow steps.
	inlineConstructor bool
}

// directCall retains resolved source identity, not an exported call DTO.
type directCall struct {
	node               ast.Invocable
	id, target, reason string
	supported, client  bool
}

func (b *graphBuilder) isClient(call ast.Invocable) bool {
	switch call.(type) {
	case *ast.BLangRemoteMethodCallAction, *ast.BLangClientResourceAccessAction:
		return true
	}
	if ref, ok := call.Receiver().(*ast.BLangVarRef); ok && !ref.Symbol().IsEmpty() {
		return semtypes.IsClientObject(semtypes.ContextFrom(b.l.p.env.GetTypeEnv()), b.l.p.env.SymbolType(ref.Symbol()))
	}
	return false
}

// expressionParts defines source evaluation order directly on the resolved AST.
func (b *graphBuilder) expressionParts(expr ast.BLangActionOrExpression) (string, []ast.BLangActionOrExpression, bool) {
	parts := []ast.BLangActionOrExpression{}
	add := func(n ast.BLangActionOrExpression) {
		if n != nil {
			parts = append(parts, n)
		}
	}
	kind := "source"
	known := true
	if b.l.p.xmlTemplates[expr] {
		if n, ok := expr.(*ast.BLangXMLTemplateExpr); ok {
			for _, e := range n.Insertions {
				add(e)
			}
		}
		return "template", parts, true
	}
	if c, ok := expr.(ast.Invocable); ok {
		kind = "call"
		add(c.Receiver())
		for _, e := range resourcePathExpressions(c) {
			add(e)
		}
		for _, e := range b.l.callArgs(c) {
			add(e)
		}
		return kind, parts, true
	}
	switch n := expr.(type) {
	case nil, *ast.BLangLiteral, *ast.BLangNumericLiteral, *ast.BLangVarRef, *ast.BLangConstRef, *ast.BLangTypedescExpr, *ast.BLangWildCardBindingPattern:
	case *ast.BLangQueryExpr:
		// Queries retain their source presentation and source-indexed call and
		// variable interactions. Their clauses are not sequential evaluations:
		// traversing them here would misrepresent filtering and per-row effects.
	case *ast.BLangCheckedExpr:
		kind = "check"
		add(n.Expr)
	case *ast.BLangCheckPanickedExpr:
		kind = "checkpanic"
		add(n.Expr)
	case *ast.BLangTrapExpr:
		kind = "trap"
		add(n.Expr)
	case *ast.BLangGroupExpr:
		kind = "group"
		add(n.Expression)
	case *ast.BLangTypeConversionExpr:
		kind = "cast"
		add(n.Expression)
	case *ast.BLangBinaryExpr:
		add(n.LhsExpr)
		add(n.RhsExpr)
	case *ast.BLangUnaryExpr:
		add(n.Expr)
	case *ast.BLangTernaryExpr:
		add(n.Condition)
		add(n.ThenExpr)
		add(n.ElseExpr)
	case *ast.BLangNilConditionalExpr:
		add(n.LhsExpr)
		add(n.RhsExpr)
	case *ast.BLangFieldBaseAccess:
		add(n.Expr)
	case *ast.BLangIndexBasedAccess:
		add(n.Expr)
		add(n.IndexExpr)
	case *ast.BLangNamedArgsExpression:
		add(n.Expr)
	case *ast.BLangListConstructorExpr:
		for _, e := range n.Exprs {
			add(e)
		}
	case *ast.BLangMappingConstructorExpr:
		for _, field := range n.Fields {
			if f, ok := field.(*ast.BLangMappingKeyValueField); ok {
				if f.Key != nil {
					add(f.Key.Expr)
				}
				add(f.ValueExpr)
			} else {
				known = false
			}
		}
	case *ast.BLangErrorConstructorExpr:
		kind = "error-constructor"
		for _, e := range n.PositionalArgs {
			add(e)
		}
		for i := range n.NamedArgs {
			add(n.NamedArgs[i].Expr)
		}
	case *ast.BLangNewExpression:
		for _, e := range b.l.newArgs(n) {
			add(e)
		}
	case *ast.BLangTypeTestExpr:
		add(n.Expr)
	case *ast.BLangXMLTemplateExpr:
		kind = "template"
		for _, e := range n.Insertions {
			add(e)
		}
	case *ast.BLangTemplateExpr:
		if n.Kind != ast.TemplateExprKindString && n.Kind != ast.TemplateExprKindXML {
			known = false
		} else {
			kind = "template"
			for _, e := range n.Insertions {
				add(e)
			}
		}
	default:
		known = false
	}
	return kind, parts, known
}
func (b *graphBuilder) scanCalls(id string, expr ast.BLangActionOrExpression, safe bool) ([]directCall, string, error) {
	calls := []directCall{}
	reason := ""
	var sourceError error
	var scan func(ast.BLangActionOrExpression, bool, int)
	scan = func(e ast.BLangActionOrExpression, expand bool, conditional int) {
		if e == nil || sourceError != nil {
			return
		}
		kind, parts, known := b.expressionParts(e)
		if !known {
			reason = fmt.Sprintf("Control effects of %T are not modeled; later source may still execute.", e)
			switch e.(type) {
			case *ast.BLangMappingConstructorExpr:
				reason = "Mapping field evaluation is not modeled."
			case *ast.BLangTemplateExpr:
				reason = "This template kind's evaluation is not modeled."
			}
		}
		if call, ok := e.(ast.Invocable); ok {
			before := len(calls)
			for _, p := range parts {
				scan(p, false, conditional)
			}
			target := b.l.functionIDs[call.ResolvedSymbol()]
			c := directCall{node: call, id: fmt.Sprintf("%s/call/%d", id, len(calls)), target: target, client: b.isClient(call)}
			c.reason = "Expansion in this expression evaluation is not modeled."
			if target == "" {
				c.reason = "The target is outside the workspace."
			} else if !b.l.availableBodies[target] {
				c.reason = "The workspace function has no available source body."
			} else if expand && before == len(calls) {
				c.supported = true
				c.reason = ""
			}
			if c.client && conditional > 0 {
				reason = "Client calls in conditionally evaluated expressions are not modeled."
			}
			if sourceError != nil {
				return
			}
			if _, sourceError = b.source(c.id, call); sourceError != nil {
				return
			}
			calls = append(calls, c)
			return
		}
		childExpand := false
		switch n := e.(type) {
		case *ast.BLangBinaryExpr:
			childExpand = expand && (n.OpKind == model.OperatorKind_ADD || n.OpKind == model.OperatorKind_SUB || n.OpKind == model.OperatorKind_MUL || n.OpKind == model.OperatorKind_DIV || n.OpKind == model.OperatorKind_MOD)
			if n.OpKind == model.OperatorKind_AND || n.OpKind == model.OperatorKind_OR {
				conditional++
			}
		case *ast.BLangTernaryExpr, *ast.BLangNilConditionalExpr:
			conditional++
		case *ast.BLangGroupExpr, *ast.BLangTypeConversionExpr:
			childExpand = expand
		}
		if kind == "check" || kind == "checkpanic" || kind == "trap" {
			childExpand = expand
			if conditional > 0 {
				reason = "Error operators in conditionally evaluated operands are not modeled."
			}
		}
		if kind == "template" || kind == "error-constructor" {
			childExpand = expand
		}
		for _, p := range parts {
			scan(p, childExpand, conditional)
		}
	}
	scan(expr, safe, 0)
	return calls, reason, sourceError
}
func (b *graphBuilder) hasEvaluation(expr ast.BLangActionOrExpression) bool {
	if expr == nil {
		return false
	}
	kind, parts, _ := b.expressionParts(expr)
	if kind == "check" || kind == "checkpanic" || kind == "trap" || kind == "template" || kind == "error-constructor" {
		return true
	}
	if c, ok := expr.(ast.Invocable); ok && b.isClient(c) {
		return true
	}
	switch n := expr.(type) {
	case *ast.BLangBinaryExpr:
		if n.OpKind == model.OperatorKind_AND || n.OpKind == model.OperatorKind_OR {
			return false
		}
	case *ast.BLangTernaryExpr, *ast.BLangNilConditionalExpr:
		return false
	}
	for _, p := range parts {
		if b.hasEvaluation(p) {
			return true
		}
	}
	return false
}
func (b *graphBuilder) evaluationExists(expr ast.BLangActionOrExpression) bool {
	if expr == nil {
		return false
	}
	kind, parts, _ := b.expressionParts(expr)
	if kind == "call" || kind == "check" || kind == "checkpanic" || kind == "trap" || kind == "template" || kind == "error-constructor" {
		return true
	}
	switch n := expr.(type) {
	case *ast.BLangBinaryExpr:
		if n.OpKind == model.OperatorKind_AND || n.OpKind == model.OperatorKind_OR {
			return false
		}
	case *ast.BLangTernaryExpr, *ast.BLangNilConditionalExpr:
		return false
	}
	for _, p := range parts {
		if b.evaluationExists(p) {
			return true
		}
	}
	return false
}

// appendEvaluation must run immediately after constructing each child, before
// constructing its next sibling. Connections belong after that child's own
// edges (including expanded-call bindings), not after all siblings' edges.
func (b *graphBuilder) appendEvaluation(f *fragment, p fragment, first bool) {
	if first {
		f.entry = p.entry
	}
	b.connect(f.normal, p.entry, HIREdgeKindSequence)
	f.normal = p.normal
	f.nodes = append(f.nodes, p.nodes...)
	f.returns = append(f.returns, p.returns...)
	appendPanics(f, p)
}
func (b *graphBuilder) evaluate(sourceID, path string, expr ast.BLangActionOrExpression, calls []directCall, force bool) (fragment, error) {
	return b.lowerExpression(path, expr, evaluationContext{kind: evaluationExpression, sourceID: sourceID, occurrencePath: path, calls: calls, force: force})
}
func (b *graphBuilder) lowerExpression(path string, expr ast.BLangActionOrExpression, context evaluationContext) (result fragment, err error) {
	if b.constructionErr != nil {
		return fragment{}, b.constructionErr
	}
	defer func() {
		if err == nil {
			err = b.constructionErr
		}
	}()
	if context.kind != evaluationExpression {
		return fragment{}, fmt.Errorf("invalid expression evaluation context")
	}
	sourceID, calls, force := context.sourceID, context.calls, context.force
	if expr == nil {
		return fragment{}, nil
	}
	kind, parts, _ := b.expressionParts(expr)
	if kind == "group" || kind == "cast" {
		// Casts retain their enclosing source text but introduce no flow node
		// or cast-specific panic path. Only the operand contributes effects.
		return b.lowerExpression(path, parts[0], context)
	}
	if !force && !b.evaluationExists(expr) {
		return fragment{}, nil
	}
	loc, err := b.source(sourceID, expr)
	if err != nil {
		return fragment{}, err
	}
	nested := fragment{}
	childIndex := 0
	for i, p := range parts {
		exists := b.evaluationExists(p)
		sid := fmt.Sprintf("%s/part/%d", sourceID, childIndex)
		if kind == "template" {
			sid = fmt.Sprintf("%s/insertion/%d", sourceID, i)
			// Plain insertions have no evaluation node, but remain part of the
			// legacy source index and count toward subsequent insertion IDs.
			if _, err := b.l.located(sid, p); err != nil {
				return fragment{}, err
			}
		}
		if !exists {
			continue
		}
		childPath := fmt.Sprintf("%s/part/%d", path, childIndex)
		child, err := b.lowerExpression(childPath, p, evaluationContext{
			kind: evaluationExpression, sourceID: sid, occurrencePath: childPath, calls: calls,
			inlineConstructor: kind == "error-constructor",
		})
		if err != nil {
			return fragment{}, err
		}
		// A pure nested constructor contributes presentation only. Do not
		// replace preceding argument effects with an empty continuation.
		if len(child.nodes) == 0 {
			childIndex++ // Retain a unique source path even without a flow node.
			continue
		}
		b.appendEvaluation(&nested, child, len(nested.nodes) == 0)
		childIndex++
	}
	if kind == "error-constructor" && context.inlineConstructor {
		return nested, nil
	}
	if (kind == "check" || kind == "checkpanic" || kind == "trap") && childIndex == 0 && len(parts) > 0 {
		child, err := b.evaluate(sourceID+"/operand", path+"/part/0", parts[0], calls, true)
		if err != nil {
			return fragment{}, err
		}
		b.appendEvaluation(&nested, child, true)
	}
	if kind == "check" || kind == "checkpanic" {
		terminalStyle := HIRNodeStyleReturn
		label := "Return error"
		role := HIRPortRoleReturn
		if kind == "checkpanic" {
			terminalStyle = HIRNodeStylePanic
			label = "Panic with error"
			role = HIRPortRolePanic
		}
		terminal := b.allocNode(path+"/error", path+"/error", sourceID, plain(terminalStyle, label))
		node := b.allocNode(path, path, sourceID, plain(HIRNodeStyleCondition, kind))
		join := b.allocPort(node, HIRPortRoleNormalExit)
		b.allocEdge(b.allocPort(node, HIRPortRoleTrue), join, HIREdgeKindTrue, "value", present())
		b.allocEdge(b.allocPort(node, HIRPortRoleFalse), b.allocPort(terminal, HIRPortRoleEntry), HIREdgeKindError, "error", present())
		entry := b.allocPort(node, HIRPortRoleEntry)
		b.connect(nested.normal, member(entry), HIREdgeKindSequence)
		b.group(node, HIRSpacingProfileIf, nil, []string{terminal}, true)
		f := nested
		f.nodes = append(f.nodes, node)
		if len(f.entry) == 0 {
			f.entry = member(entry)
		}
		f.normal = member(join)
		if role == HIRPortRoleReturn {
			f.returns = append(f.returns, member(b.allocPort(terminal, role))...)
		} else {
			f.panics = append(f.panics, member(b.allocPort(terminal, role))...)
		}
		return f, nil
	}
	if kind == "trap" {
		capture := b.allocNode(path+"/capture", path+"/capture", sourceID, plain(HIRNodeStyleStep, "Capture panic as error value"))
		node := b.allocNode(path, path, sourceID, plain(HIRNodeStyleTrap, "trap"))
		exit := b.allocPort(node, HIRPortRoleNormalExit)
		entry := b.allocPort(node, HIRPortRoleEntry)
		if len(nested.entry) == 0 {
			b.allocEdge(entry, exit, HIREdgeKindSequence, "", present())
		} else {
			b.connect(member(entry), nested.entry, HIREdgeKindSequence)
		}
		b.connect(nested.normal, member(exit), HIREdgeKindSequence)
		for i := 0; i <= len(nested.panics); i++ {
			for _, exp := range nested.panicExports {
				if exp.before == i {
					b.catchPanic(exp.reference, b.allocPort(capture, HIRPortRoleEntry))
				}
			}
			if i < len(nested.panics) {
				p := nested.panics[i]
				b.allocEdge(p.PortID, b.allocPort(capture, HIRPortRoleEntry), HIREdgeKindPanic, "panic", p.When)
			}
		}
		b.allocEdge(b.allocPort(capture, HIRPortRoleNormalExit), exit, HIREdgeKindSequence, "error value", present())
		b.group(node, HIRSpacingProfileTrap, append(nested.nodes, capture), nil, false)
		return fragment{nodes: []string{node}, entry: member(entry), normal: member(exit), returns: nested.returns}, nil
	}
	style := HIRNodeStyleStep
	if kind == "template" {
		style = HIRNodeStyleTemplate
	}
	var call *directCall
	if inv, ok := expr.(ast.Invocable); ok {
		for i := range calls {
			if calls[i].node == inv {
				call = &calls[i]
				break
			}
		}
	}
	if call != nil && call.target != "" {
		style = HIRNodeStyleFunction
	}
	presentation := plain(style, loc.Text)
	if constructor, ok := expr.(*ast.BLangErrorConstructorExpr); ok {
		presentation, err = b.errorConstructorPresentation(sourceID, constructor)
		if err != nil {
			return fragment{}, err
		}
	}
	if kind == "template" {
		templateType := "string"
		if b.l.p.xmlTemplates[expr] {
			templateType = "xml"
		}
		switch n := expr.(type) {
		case *ast.BLangXMLTemplateExpr:
			templateType = "xml"
		case *ast.BLangTemplateExpr:
			if n.Kind == ast.TemplateExprKindXML {
				templateType = "xml"
			}
		}
		// The AST determines the type; preserve the expression's original bytes
		// rather than reconstructing XML or interpolations from the AST.
		expression := strings.TrimSpace(strings.TrimPrefix(loc.Text, templateType))
		p := presentation.Value.(HIRPlainPresentation)
		p.Sections = HIRList[HIRLabelSection]{
			{Kind: HIRLabelSectionKindTemplateType, Text: HIRText(templateType)},
			{Kind: HIRLabelSectionKindTemplateExpression, Text: HIRText(expression)},
		}
		presentation.Value = p
	}
	if call != nil && call.client {
		presentation, err = b.clientPresentation(call, path)
		if err != nil {
			return fragment{}, err
		}
	}
	node := b.allocNode(path, path, sourceID, presentation)
	if b.statementView {
		position := expr.GetPosition()
		switch p := presentation.Value.(type) {
		case HIRPlainPresentation:
			if string(p.Label) == loc.Text {
				b.node(node).Calls = b.functionCalls(loc.Source.File, position.StartOffset(), "", loc.Text)
			} else {
				b.node(node).Calls = b.structuredFunctionCalls(loc.Source.File, position.StartOffset(), position.EndOffset(), string(p.Label))
			}
		case HIRClientPresentation:
			b.node(node).Calls = b.structuredFunctionCalls(loc.Source.File, position.StartOffset(), position.EndOffset(), string(p.Label))
		}
	}
	if call != nil {
		b.node(node).SourceID = call.id
	}
	entry := b.allocPort(node, HIRPortRoleEntry)
	b.connect(nested.normal, member(entry), HIREdgeKindSequence)
	normal := member(b.allocPort(node, HIRPortRoleNormalExit))
	panics := nested.panics
	// Constructing an error is a normal value operation; only its arguments
	// contribute control effects.
	if kind != "error-constructor" {
		panics = append(panics, member(b.allocPort(node, HIRPortRolePanic))...)
	}
	if call != nil && call.target != "" && !b.statementView {
		normal = b.bindCall(node, path+"/expand", *call, true)
		nested.panicExports = append(nested.panicExports, panicExport{reference: node, before: len(panics)})
	}
	f := nested
	f.nodes = append(f.nodes, node)
	if len(f.entry) == 0 {
		f.entry = member(entry)
	}
	f.normal = normal
	f.panics = panics
	return f, nil
}
func (b *graphBuilder) clientPresentation(c *directCall, path string) (HIRPresentation, error) {
	value, err := b.l.clientPresentation(c.id, c.node)
	if err != nil {
		return HIRPresentation{}, err
	}
	p := value.presentation.Value.(HIRClientPresentation)
	if disclosure, ok := p.Disclosure.Value.(HIRClientContextDisclosure); ok {
		disclosure.OccurrenceKey = strings.TrimPrefix(path, b.graph.ID) + "/context"
		p.Disclosure.Value = disclosure
	}
	return HIRPresentation{Value: p}, nil
}
func (b *graphBuilder) bindCall(node, occ string, c directCall, evaluation bool) []HIRInterfaceMember {
	f, err := b.lowerCall(occ, c.node, evaluationContext{kind: evaluationCall, sourceID: c.id, occurrencePath: occ, call: c, nodeID: node, evaluation: evaluation})
	b.recordError(err)
	return f.normal
}
func (b *graphBuilder) lowerCall(path string, call ast.Invocable, context evaluationContext) (result fragment, err error) {
	if b.constructionErr != nil {
		return fragment{}, b.constructionErr
	}
	defer func() {
		if err == nil {
			err = b.constructionErr
		}
	}()
	if context.kind != evaluationCall || call == nil || context.call.node != call {
		return fragment{}, fmt.Errorf("invalid resolved call evaluation context")
	}
	b.node(context.nodeID)
	if b.constructionErr != nil {
		return fragment{}, b.constructionErr
	}
	normal := b.bindCallReference(context.nodeID, path, context.call, context.evaluation)
	return fragment{normal: normal}, nil
}

// bindCallReference accepts resolved construction facts, also used by the
// test-only synthetic adapter without fabricating AST invocations.
func (b *graphBuilder) bindCallReference(node, occ string, c directCall, evaluation bool) []HIRInterfaceMember {
	availability := HIRAvailability{Value: HIRAvailable{}}
	if !c.supported {
		availability = HIRAvailability{Value: HIRUnavailable{Reason: c.reason}}
	}
	n := b.node(node)
	occ = strings.TrimPrefix(occ, b.graph.ID)
	reason := "Recursive calls remain collapsed."
	// Ordinary calls report source unavailability before recursion; evaluation
	// calls report recursion first. The accessible name always uses the chosen label.
	if !evaluation && !c.supported {
		reason = c.reason
	}
	callDisclosure := func(label HIRText, sections HIRList[HIRLabelSection], variables HIRList[HIRVariableOccurrence]) HIRCallDisclosure {
		return HIRCallDisclosure{OccurrenceKey: occ, Availability: availability, Recursive: HIRRecursivePresentation{Label: label, Sections: sections, Variables: variables, Limitation: &reason, Title: HIRText(reason), AriaLabel: HIRText("Recursive call " + string(label)), Glyph: "↻"}}
	}
	switch p := n.Presentation.Value.(type) {
	case HIRPlainPresentation:
		p.Disclosure = HIRDisclosure{Value: callDisclosure(p.Label, HIRList[HIRLabelSection]{}, p.Variables)}
		n.Presentation = HIRPresentation{Value: p}
	case HIRClientPresentation:
		call := callDisclosure(p.Label, p.Sections, p.Variables)
		if context, ok := p.Disclosure.Value.(HIRClientContextDisclosure); ok {
			call = callDisclosure(context.Collapsed.Label, context.Collapsed.Sections, context.Collapsed.Variables)
			context.Call = &call
			expanded := callDisclosure(context.Expanded.Label, context.Expanded.Sections, context.Expanded.Variables).Recursive
			context.ExpandedRecursive = &expanded
			p.Disclosure = HIRDisclosure{Value: context}
		} else {
			p.Disclosure = HIRDisclosure{Value: call}
		}
		n.Presentation = HIRPresentation{Value: p}
	}
	if !c.supported && !evaluation {
		interfaces := HIRList[HIRInterface]{}
		for _, id := range []string{"entry", "normal", "returns", "panics"} {
			interfaces = append(interfaces, HIRInterface{ID: id, Members: HIRList[HIRInterfaceMember]{}, Exports: HIRList[HIRInterfaceExport]{}, Root: HIRRootTreatment{Value: HIRTerminalRoot{}}})
		}
		b.node(node).Body = HIRNodeBody{Value: HIRReferenceBody{Reference: HIRGraphReference{GraphID: c.target, OccurrenceKey: occ, Availability: availability, Container: groupStyle(HIRSpacingProfileCall), Collapsed: HIRCollapsedReference{Interfaces: interfaces, Edges: HIRList[HIREdge]{}}, Inline: HIRList[HIRBinding]{}}}}
		for _, stream := range []string{"nodes", "ports", "edges"} {
			b.emit(stream, HIREmission{Value: HIRChildEmission{ReferenceNodeID: node, When: present()}})
		}
		return nil
	}
	entry := b.allocPort(node, HIRPortRoleEntry)
	completion := b.allocPort(node, HIRPortRoleNormalExit)
	iface := func(id string, ms []HIRInterfaceMember) HIRInterface {
		return HIRInterface{ID: id, Members: append(HIRList[HIRInterfaceMember]{}, ms...), Exports: HIRList[HIRInterfaceExport]{}, Root: HIRRootTreatment{Value: HIRTerminalRoot{}}}
	}
	ref := HIRGraphReference{GraphID: c.target, OccurrenceKey: occ, Availability: availability, Container: groupStyle(HIRSpacingProfileCall), Collapsed: HIRCollapsedReference{Interfaces: HIRList[HIRInterface]{iface("entry", member(entry)), iface("normal", member(completion)), iface("returns", nil), iface("panics", nil)}, Edges: HIRList[HIREdge]{}}, Inline: HIRList[HIRBinding]{}}
	bind := func(v HIRBindingValue) { ref.Inline = append(ref.Inline, HIRBinding{Value: v}) }
	bind(HIREntryBinding{ID: node + "/enter", When: present(), CallerPortID: entry, TargetInterfaceID: "entry", Edge: edgeStyle(HIREdgeKindSequence, "")})
	for _, id := range []string{"normal", "returns"} {
		bind(HIRExitBinding{ID: node + "/exit/" + id, When: present(), CallerPortID: completion, TargetInterfaceID: id, Edge: edgeStyle(HIREdgeKindReturn, "")})
	}

	b.node(node).Body = HIRNodeBody{Value: HIRReferenceBody{Reference: ref}}
	for _, stream := range []string{"nodes", "ports", "edges"} {
		b.emit(stream, HIREmission{Value: HIRChildEmission{ReferenceNodeID: node, When: present()}})
	}
	for _, binding := range ref.Inline {
		id := ""
		switch x := binding.Value.(type) {
		case HIREntryBinding:
			id = x.ID
		case HIRExitBinding:
			id = x.ID
		case HIRExportBinding:
			continue
		}
		b.emit("edges", HIREmission{Value: HIRBindingEmission{BindingID: id, When: present()}})
	}
	b.allocEdge(entry, completion, HIREdgeKindSequence, "", not(nonempty(node, "entry")))
	return guarded(member(completion), anyPresence(not(nonempty(node, "entry")), nonempty(node, "normal"), nonempty(node, "returns")))
}
func (b *graphBuilder) addPanicExport(node string, before int) {
	body := b.node(node).Body.Value.(HIRReferenceBody)
	id := node + "/export/panics"
	body.Reference.Inline = append(body.Reference.Inline, HIRBinding{Value: HIRExportBinding{ID: id, When: present(), TargetInterfaceID: "panics", CallerInterfaceID: "panics"}})
	b.node(node).Body.Value = body
	for i := range b.graph.Interfaces {
		if b.graph.Interfaces[i].ID == "panics" {
			b.graph.Interfaces[i].Exports = append(b.graph.Interfaces[i].Exports, HIRInterfaceExport{BindingID: id, BeforeMember: before})
			return
		}
	}
}
func (b *graphBuilder) catchPanic(node, port string) {
	body := b.node(node).Body.Value.(HIRReferenceBody)
	id := node + "/catch/panics"
	body.Reference.Inline = append(body.Reference.Inline, HIRBinding{Value: HIRExitBinding{ID: id, When: present(), TargetInterfaceID: "panics", CallerPortID: port, Edge: edgeStyle(HIREdgeKindPanic, "panic")}})
	b.node(node).Body.Value = body
	b.emit("edges", HIREmission{Value: HIRBindingEmission{BindingID: id, When: present()}})
}

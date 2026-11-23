package compiler

import (
	"fmt"
	"slices"
	"strings"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/model"
	"github.com/ballerina-nutcracker/ballerina/semtypes"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

type CallTargetModel struct {
	Kind       string `json:"kind"`
	FunctionID string `json:"functionId,omitempty"`
	Label      string `json:"label,omitempty"`
}
type ReceiverContextModel struct {
	Receiver    LocatedModel  `json:"receiver"`
	Type        string        `json:"type,omitempty"`
	Origin      string        `json:"origin"`
	Initializer *LocatedModel `json:"initializer,omitempty"`
}
type ClientInvocationModel struct {
	Context   ReceiverContextModel `json:"context"`
	Method    string               `json:"method"`
	Arguments []LocatedModel       `json:"arguments"`
}
type EvaluationModel struct {
	LocatedModel
	Kind     string            `json:"kind"`
	Children []EvaluationModel `json:"children"`
	Call     *CallSiteModel    `json:"call,omitempty"`
	Strings  []string          `json:"strings,omitempty"`
}
type CallSiteModel struct {
	LocatedModel
	Client    *ClientInvocationModel `json:"client,omitempty"`
	Target    CallTargetModel        `json:"target"`
	Expansion string                 `json:"expansion"`
	Reason    string                 `json:"reason,omitempty"`
}
type ExpressionModel struct {
	LocatedModel
	Calls      []CallSiteModel  `json:"calls"`
	Evaluation *EvaluationModel `json:"evaluation,omitempty"`
}
type StatementModel struct {
	LocatedModel
	Evaluation   *EvaluationModel  `json:"evaluation,omitempty"`
	Binding      string            `json:"binding,omitempty"`
	Kind         string            `json:"kind"`
	Operation    string            `json:"operation,omitempty"`
	Presentation string            `json:"presentation,omitempty"`
	Calls        *[]CallSiteModel  `json:"calls,omitempty"`
	Condition    *ExpressionModel  `json:"condition,omitempty"`
	Header       *ExpressionModel  `json:"header,omitempty"`
	ThenBody     *[]StatementModel `json:"thenBody,omitempty"`
	ElseBody     *[]StatementModel `json:"elseBody,omitempty"`
	Body         *[]StatementModel `json:"body,omitempty"`
	Reason       string            `json:"reason,omitempty"`
}
type FunctionModel struct {
	LocatedModel
	ModuleID string             `json:"moduleId"`
	Entry    FunctionEntryModel `json:"entry"`
	Body     []StatementModel   `json:"body"`
}
type FunctionEntryModel struct {
	Kind       string                   `json:"kind"`
	Name       string                   `json:"name"`
	Signature  string                   `json:"signature"`
	Parameters []FunctionParameterModel `json:"parameters"`
	ReturnType string                   `json:"returnType"`
}
type FunctionParameterModel struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type ProgramModel struct {
	Scopes    []ScopeModel             `json:"scopes"`
	Functions map[string]FunctionModel `json:"functions"`
}

// legacyExtractor is an independent test oracle, never frontend resolution state.
type legacyExtractor struct {
	*resolvedProgram
	receiverContexts map[model.SymbolRef]ReceiverContextModel
	functionIDs      map[model.SymbolRef]string
	availableBodies  map[string]bool
}

func extractProgram(p *resolvedProgram) (ProgramModel, error) {
	return (&legacyExtractor{resolvedProgram: p}).extractProgram()
}

func (p *resolvedProgram) located(id string, node ast.Node) LocatedModel {
	location := node.GetPosition()
	ref, err := sourceReference(p.files, p.env.DiagnosticEnv(), location)
	if err != nil {
		panic(err)
	}
	return LocatedModel{ID: id, Source: ref, Text: p.files[ref.File][location.StartOffset():location.EndOffset()]}
}

type extractionFunction struct {
	node         sourceFunction
	moduleID, id string
	owner        string
}

func (p *legacyExtractor) extractProgram() (ProgramModel, error) {
	result := ProgramModel{Scopes: []ScopeModel{}, Functions: map[string]FunctionModel{}}
	p.functionIDs = map[model.SymbolRef]string{}
	p.availableBodies = map[string]bool{}
	p.collectReceiverContexts()
	var functions []extractionFunction
	addFunction := func(fn sourceFunction, moduleID, id, owner string) {
		p.functionIDs[fn.Symbol()] = id
		switch fn.GetBody().(type) {
		case *ast.BLangBlockFunctionBody, *ast.BLangExprFunctionBody:
			p.availableBodies[id] = true
		}
		functions = append(functions, extractionFunction{fn, moduleID, id, owner})
	}
	// Collect definition identities before resolving any call sites.
	serviceIDs := map[*ast.BLangService]string{}
	for _, mod := range p.modules {
		if !mod.workspace {
			continue
		}
		moduleID := mod.module.Descriptor().Org().Value() + "/" + mod.module.ModuleName().String()
		for _, fn := range mod.pkg.Functions {
			addFunction(fn, moduleID, moduleID+"/function/"+fn.Name.GetValue(), "")
		}
		for _, class := range mod.pkg.ClassDefinitions {
			names := []string{}
			for name := range class.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				addFunction(class.Methods[name], moduleID, moduleID+"/class/"+class.Name.GetValue()+"/method/"+name, class.Name.GetValue())
			}
			for _, fn := range class.ResourceMethods {
				addFunction(fn, moduleID, moduleID+"/class/"+class.Name.GetValue()+"/resource/"+legacyResourceSignature(p, fn), class.Name.GetValue())
			}
		}
		counts := map[string]int{}
		for _, service := range mod.pkg.Services {
			loc := service.GetPosition()
			path := legacyServicePath(service)
			key := moduleID + "/service/" + p.env.DiagnosticEnv().FileName(loc) + "/" + path
			counts[key]++
			id := fmt.Sprintf("%s/%d", key, counts[key])
			serviceIDs[service] = id
			names := make([]string, 0, len(service.Methods))
			for name := range service.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				addFunction(service.Methods[name], moduleID, id+"/method/"+name, "")
			}
			for _, fn := range service.ResourceMethods {
				addFunction(fn, moduleID, id+"/resource/"+legacyResourceSignature(p, fn), "")
			}
		}
	}
	for _, fn := range functions {
		var body []StatementModel
		switch node := fn.node.GetBody().(type) {
		case *ast.BLangBlockFunctionBody:
			var err error
			body, err = extractStatements(p, fn.id, node.Stmts)
			if err != nil {
				return ProgramModel{}, err
			}
		case *ast.BLangExprFunctionBody:
			stmt := StatementModel{LocatedModel: p.located(fn.id+"/expression", node.Expr), Kind: "return"}
			calls, reason := p.expressionCalls(stmt.ID, node.Expr, true)
			if reason != "" {
				stmt.Kind = "unsupported"
				stmt.Reason = reason
			} else {
				stmt.Calls = &calls
				stmt.Evaluation = p.renderedEvaluation(stmt.ID+"/value", node.Expr, calls)
			}
			body = []StatementModel{stmt}
		default:
			body = []StatementModel{{LocatedModel: p.located(fn.id+"/body", fn.node), Kind: "unsupported", Reason: "Function body is unavailable for visualization."}}
		}
		entry := FunctionEntryModel{Kind: "function", Name: strings.TrimPrefix(fn.node.GetName().GetValue(), "$remote$"), Parameters: []FunctionParameterModel{}, ReturnType: "()"}
		if fn.node.IsAttached() {
			entry.Kind = "method"
		}
		if fn.owner != "" {
			entry.Name = fn.owner + "." + entry.Name
		}
		if fn.node.IsRemote() {
			entry.Kind = "remote"
		}
		if resource, ok := fn.node.(*ast.BLangResourceMethod); ok {
			entry.Kind = "resource"
			entry.Name = resource.Name.GetValue() + " /" + legacyResourcePath(p, resource)
			for i := range resource.ResourcePath {
				segment := &resource.ResourcePath[i]
				if segment.Kind != ast.ResourcePathSegmentName {
					entry.Parameters = append(entry.Parameters, FunctionParameterModel{Kind: "path", Text: p.located("path", segment).Text})
				}
			}
		}
		for i, param := range fn.node.GetParameters() {
			entry.Parameters = append(entry.Parameters, FunctionParameterModel{Kind: "input", Text: p.located(fmt.Sprintf("parameter/%d", i), &param).Text})
		}
		if param := fn.node.GetRestParam(); param != nil {
			entry.Parameters = append(entry.Parameters, FunctionParameterModel{Kind: "input", Text: p.located("rest", param).Text})
		}
		if descriptor := fn.node.GetReturnTypeDescriptor(); fn.node.HasExplicitReturnTypeDescriptor() && descriptor != nil {
			entry.ReturnType = p.located("returnType", descriptor).Text
		}
		location := fn.node.GetPosition()
		end := location.EndOffset()
		if fn.node.HasBody() {
			bodyLocation := fn.node.GetBody().GetPosition()
			end = bodyLocation.StartOffset()
		}
		entry.Signature = strings.TrimSpace(p.files[p.env.DiagnosticEnv().FileName(location)][location.StartOffset():end])
		result.Functions[fn.id] = FunctionModel{LocatedModel: p.located(fn.id, fn.node), ModuleID: fn.moduleID, Entry: entry, Body: body}
	}
	for _, mod := range p.modules {
		if !mod.workspace {
			continue
		}
		moduleID := mod.module.Descriptor().Org().Value() + "/" + mod.module.ModuleName().String()
		definitions := []DefinitionModel{}
		for _, fn := range mod.pkg.Functions {
			id := p.functionIDs[fn.Symbol()]
			definitions = append(definitions, DefinitionModel{LocatedModel: p.located(id, fn), Kind: "function", Label: fn.Name.GetValue(), FunctionID: id})
		}
		for _, ty := range mod.pkg.TypeDefinitions {
			definitions = append(definitions, DefinitionModel{LocatedModel: p.located(moduleID+"/type/"+ty.Name.GetValue(), ty), Kind: "type", Label: ty.Name.GetValue()})
		}
		typeContext := semtypes.ContextFrom(p.env.GetTypeEnv())
		connector := func(v *ast.BLangVariable, owner string) (DefinitionModel, bool) {
			if semtypes.IsClientObject(typeContext, p.env.SymbolType(v.Symbol())) {
				return DefinitionModel{LocatedModel: p.located(owner+"/connector/"+v.Name.GetValue(), v), Kind: "connector", Label: v.Name.GetValue()}, true
			}
			return DefinitionModel{}, false
		}
		for _, v := range mod.pkg.GlobalVars {
			if d, ok := connector(v, moduleID); ok {
				definitions = append(definitions, d)
			}
		}
		for _, service := range mod.pkg.Services {
			id := serviceIDs[service]
			defs := append([]DefinitionModel{}, definitions...)
			endpoints := []EndpointModel{}
			names := []string{}
			for name := range service.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			path := legacyServicePath(service)
			for _, name := range names {
				fn := service.Methods[name]
				fid := p.functionIDs[fn.Symbol()]
				if fn.IsRemote() {
					endpoints = append(endpoints, EndpointModel{LocatedModel: p.located(fid, fn), Kind: "remote", Title: strings.TrimPrefix(name, "$remote$"), FunctionID: fid})
				} else {
					defs = append(defs, DefinitionModel{LocatedModel: p.located(fid, fn), Kind: "function", Label: name, FunctionID: fid})
				}
			}
			for _, fn := range service.ResourceMethods {
				fid := p.functionIDs[fn.Symbol()]
				title := fn.Name.GetValue() + " " + strings.TrimRight(path, "/") + "/" + legacyResourcePath(p, fn)
				endpoints = append(endpoints, EndpointModel{LocatedModel: p.located(fid, fn), Kind: "resource", Title: title, FunctionID: fid})
			}
			for _, v := range service.Fields {
				if d, ok := connector(v, id); ok {
					defs = append(defs, d)
				}
			}
			var serviceType *string
			for _, expr := range service.AttachedExprs {
				if n, ok := expr.(*ast.BLangNewExpression); ok && !n.ClassSymbol.IsEmpty() {
					pkg := p.env.SymbolPackage(n.ClassSymbol)
					label := pkg.Organization + "/" + pkg.Package + ":" + p.env.SymbolName(n.ClassSymbol)
					serviceType = &label
					break
				}
			}
			title := path
			if title == "" {
				title = "Service"
				if serviceType != nil {
					title += " · " + *serviceType
				}
			}
			result.Scopes = append(result.Scopes, ScopeModel{LocatedModel: p.located(id, service), Kind: "service", Title: title, ModuleID: moduleID, ServiceType: serviceType, Endpoints: &endpoints, Definitions: &defs})
		}
	}
	if len(result.Scopes) == 0 {
		for _, fn := range functions {
			if fn.node.GetName().GetValue() == "main" && !fn.node.IsAttached() {
				result.Scopes = append(result.Scopes, ScopeModel{LocatedModel: p.located(fn.id, fn.node), Kind: "automation", Title: "Automation", ModuleID: fn.moduleID, FunctionID: fn.id})
			}
		}
	}
	slices.SortFunc(result.Scopes, func(a, b ScopeModel) int { return strings.Compare(a.ID, b.ID) })
	// Disambiguation changes labels, never the identity used by conversations.
	titles := map[string]int{}
	for _, scope := range result.Scopes {
		if scope.Kind == "service" {
			titles[scope.Title]++
		}
	}
	for i := range result.Scopes {
		scope := &result.Scopes[i]
		if scope.Kind == "service" && titles[scope.Title] > 1 {
			scope.Title += " · " + scope.ModuleID + " · " + scope.Source.File + fmt.Sprintf(":%d", scope.Source.Range.Start.Line)
		}
	}
	return result, nil
}
func legacyResourcePath(p *legacyExtractor, fn *ast.BLangResourceMethod) string {
	parts := []string{}
	for i := range fn.ResourcePath {
		parts = append(parts, p.located("path", &fn.ResourcePath[i]).Text)
	}
	return strings.Join(parts, "/")
}
func legacyResourceSignature(p *legacyExtractor, fn *ast.BLangResourceMethod) string {
	return fn.Name.GetValue() + "/" + legacyResourcePath(p, fn)
}

func extractStatements(p *legacyExtractor, functionID string, nodes []ast.StatementNode) ([]StatementModel, error) {
	result := make([]StatementModel, 0, len(nodes))
	for i, node := range nodes {
		id := fmt.Sprintf("%s/statement/%d", functionID, i)
		stmt := StatementModel{LocatedModel: p.located(id, node)}
		var expr ast.BLangActionOrExpression
		var lhs ast.BLangExpression
		switch n := node.(type) {
		case *ast.BLangBlockStmt:
			nested, err := extractStatements(p, id+"/block", n.Stmts)
			if err != nil {
				return nil, err
			}
			result = append(result, nested...)
			continue
		case *ast.BLangVariableDef:
			stmt.Kind = "simple"
			stmt.Operation = "declare"
			expr = n.Var.Expr
		case *ast.BLangAssignment:
			stmt.Kind = "simple"
			stmt.Operation = "assign"
			lhs = n.VarRef
			expr = n.Expr
		case *ast.BLangCompoundAssignment:
			stmt.Kind = "simple"
			stmt.Operation = "assign"
			lhs = n.VarRef
			expr = n.Expr
		case *ast.BLangExpressionStmt:
			stmt.Kind = "simple"
			stmt.Operation = "expression"
			expr = n.Expr
		case *ast.BLangReturn:
			stmt.Kind = "return"
			expr = n.Expr
		case *ast.BLangBreak:
			stmt.Kind = "break"
		case *ast.BLangContinue:
			stmt.Kind = "continue"
		case *ast.BLangIf:
			stmt.Kind = "if"
			condition := p.expression(id+"/condition", n.Expr, false)
			stmt.Condition = &condition
			then, _ := extractStatements(p, id+"/then", n.Body.Stmts)
			stmt.ThenBody = &then
			elseBody := []StatementModel{}
			if n.ElseStmt != nil {
				if block, ok := n.ElseStmt.(*ast.BLangBlockStmt); ok {
					elseBody, _ = extractStatements(p, id+"/else", block.Stmts)
				} else {
					elseBody, _ = extractStatements(p, id+"/else", []ast.StatementNode{n.ElseStmt})
				}
			}
			stmt.ElseBody = &elseBody
			if _, reason := p.expressionCalls(id, n.Expr, false); reason != "" {
				stmt = StatementModel{LocatedModel: stmt.LocatedModel, Kind: "unsupported", Reason: reason}
			}
		case *ast.BLangWhile:
			stmt.Kind = "while"
			condition := p.expression(id+"/condition", n.Expr, false)
			stmt.Condition = &condition
			body, _ := extractStatements(p, id+"/loop", n.Body.Stmts)
			stmt.Body = &body
			if _, reason := p.expressionCalls(id, n.Expr, false); reason != "" {
				stmt = StatementModel{LocatedModel: stmt.LocatedModel, Kind: "unsupported", Reason: reason}
			}
			if n.OnFailClause.Body != nil {
				stmt = StatementModel{LocatedModel: stmt.LocatedModel, Kind: "unsupported", Reason: "Loop on-fail behavior is not modeled."}
			}
		case *ast.BLangForeach:
			stmt.Kind = "foreach"
			header := p.expression(id+"/header", n.Collection, false)
			loc := n.VariableDef.GetPosition()
			end := n.Collection.GetPosition()
			loc = diagnostics.NewLocation(p.env.DiagnosticEnv(), header.Source.File, loc.StartOffset(), end.EndOffset())
			ref, err := sourceReference(p.files, p.env.DiagnosticEnv(), loc)
			if err != nil {
				return nil, err
			}
			header.Source = ref
			header.Text = p.files[ref.File][loc.StartOffset():loc.EndOffset()]
			stmt.Header = &header
			body, _ := extractStatements(p, id+"/loop", n.Body.Stmts)
			stmt.Body = &body
			if _, reason := p.expressionCalls(id, n.Collection, false); reason != "" {
				stmt = StatementModel{LocatedModel: stmt.LocatedModel, Kind: "unsupported", Reason: reason}
			}
			if n.OnFailClause != nil {
				stmt = StatementModel{LocatedModel: stmt.LocatedModel, Kind: "unsupported", Reason: "Loop on-fail behavior is not modeled."}
			}
		default:
			stmt.Kind = "unsupported"
			stmt.Reason = fmt.Sprintf("Visualization of %T is not modeled; later source may still execute.", node)
		}
		if stmt.Kind == "simple" || stmt.Kind == "return" {
			prefix, lhsReason := p.expressionCalls(id+"/lhs", lhs, false)
			calls, reason := p.expressionCalls(id, expr, len(prefix) == 0)
			calls = append(prefix, calls...)
			if lhsReason != "" {
				reason = lhsReason
			}
			if reason != "" {
				stmt.Kind = "unsupported"
				stmt.Operation = ""
				stmt.Reason = reason
			} else {
				stmt.Calls = &calls
				stmt.Evaluation = p.statementEvaluation(id, node, lhs, expr, calls)
				if stmt.Evaluation != nil && expr != nil && stmt.Kind == "simple" && stmt.Operation != "expression" {
					stmtPos, exprPos := node.GetPosition(), expr.GetPosition()
					start, end := stmtPos.StartOffset(), exprPos.StartOffset()
					stmt.Binding = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(p.files[stmt.Source.File][start:end]), "="))
					if lhs != nil {
						stmt.Binding = p.located(id+"/binding", lhs).Text
					}
				}
				if stmt.Kind == "simple" {
					stmt.Presentation = "step"
					if _, ok := expr.(*ast.BLangMappingConstructorExpr); ok {
						stmt.Presentation = "mapping"
					}
				}
			}
		}
		result = append(result, stmt)
	}
	return result, nil
}
func (p *legacyExtractor) expression(id string, expr ast.BLangActionOrExpression, safe bool) ExpressionModel {
	calls, _ := p.expressionCalls(id, expr, safe)
	return ExpressionModel{LocatedModel: p.located(id, expr), Calls: calls, Evaluation: p.renderedEvaluation(id+"/value", expr, calls)}
}
func resolveCallTarget(p *legacyExtractor, call ast.Invocable) (CallTargetModel, error) {
	symbol := call.ResolvedSymbol()
	if symbol.IsEmpty() {
		return CallTargetModel{}, fmt.Errorf("unresolved invocation")
	}
	if id, ok := p.functionIDs[symbol]; ok {
		return CallTargetModel{Kind: "workspace", FunctionID: id}, nil
	}
	return CallTargetModel{Kind: "external", Label: p.env.SymbolName(symbol)}, nil
}

func (p *legacyExtractor) expressionCalls(id string, expr ast.BLangActionOrExpression, safe bool) ([]CallSiteModel, string) {
	calls := []CallSiteModel{}
	reason := ""
	conditional := 0
	var scan func(ast.BLangActionOrExpression, bool)
	scan = func(expr ast.BLangActionOrExpression, expand bool) {
		if expr == nil {
			return
		}
		if call, ok := expr.(ast.Invocable); ok {
			before := len(calls)
			if call.Receiver() != nil {
				scan(call.Receiver(), false)
			}
			for _, segment := range resourcePathExpressions(call) {
				scan(segment, false)
			}
			for _, arg := range p.callArgs(call) {
				scan(arg, false)
			}
			target, err := resolveCallTarget(p, call)
			if err != nil {
				panic(err)
			}
			site := CallSiteModel{LocatedModel: p.located(fmt.Sprintf("%s/call/%d", id, len(calls)), expr), Target: target, Expansion: "unavailable", Reason: "Expansion in this expression evaluation is not modeled."}
			if target.Kind == "external" {
				site.Reason = "The target is outside the workspace."
			} else if !p.availableBodies[target.FunctionID] {
				site.Reason = "The workspace function has no available source body."
			} else if expand && before == len(calls) {
				site.Expansion = "supported"
				site.Reason = ""
			}
			site.Client = p.clientInvocation(site.ID, call)
			if conditional > 0 && site.Client != nil {
				reason = "Client calls in conditionally evaluated expressions are not modeled."
			}
			calls = append(calls, site)
			return
		}
		switch n := expr.(type) {
		case *ast.BLangLiteral, *ast.BLangNumericLiteral, *ast.BLangVarRef, *ast.BLangConstRef, *ast.BLangTypedescExpr, *ast.BLangWildCardBindingPattern:
		case *ast.BLangBinaryExpr:
			// Arithmetic operands execute in order, so their calls can use the
			// statement's sequential expansion. Keep conditional evaluation and
			// contexts that already disallow expansion conservative.
			arithmetic := n.OpKind == model.OperatorKind_ADD || n.OpKind == model.OperatorKind_SUB ||
				n.OpKind == model.OperatorKind_MUL || n.OpKind == model.OperatorKind_DIV || n.OpKind == model.OperatorKind_MOD
			shortCircuit := n.OpKind == model.OperatorKind_AND || n.OpKind == model.OperatorKind_OR
			if shortCircuit {
				conditional++
			}
			scan(n.LhsExpr, expand && arithmetic)
			scan(n.RhsExpr, expand && arithmetic)
			if shortCircuit {
				conditional--
			}
		case *ast.BLangGroupExpr:
			scan(n.Expression, expand)
		case *ast.BLangUnaryExpr:
			scan(n.Expr, false)
		case *ast.BLangTernaryExpr:
			conditional++
			scan(n.Condition, false)
			scan(n.ThenExpr, false)
			scan(n.ElseExpr, false)
			conditional--
		case *ast.BLangNilConditionalExpr:
			conditional++
			scan(n.LhsExpr, false)
			scan(n.RhsExpr, false)
			conditional--
		case *ast.BLangListConstructorExpr:
			for _, e := range n.Exprs {
				scan(e, false)
			}
		case *ast.BLangMappingConstructorExpr:
			for _, f := range n.Fields {
				if field, ok := f.(*ast.BLangMappingKeyValueField); ok {
					if field.Key != nil {
						scan(field.Key.Expr, false)
					}
					scan(field.ValueExpr, false)
				} else {
					reason = "Mapping field evaluation is not modeled."
				}
			}
		case *ast.BLangFieldBaseAccess:
			scan(n.Expr, false)
		case *ast.BLangIndexBasedAccess:
			scan(n.Expr, false)
			scan(n.IndexExpr, false)
		case *ast.BLangNamedArgsExpression:
			scan(n.Expr, false)
		case *ast.BLangNewExpression:
			for _, e := range p.newArgs(n) {
				scan(e, false)
			}
		case *ast.BLangTypeTestExpr:
			scan(n.Expr, false)
		case *ast.BLangCheckedExpr:
			if conditional > 0 {
				reason = "Error operators in conditionally evaluated operands are not modeled."
			}
			scan(n.Expr, expand)
		case *ast.BLangCheckPanickedExpr:
			if conditional > 0 {
				reason = "Error operators in conditionally evaluated operands are not modeled."
			}
			scan(n.Expr, expand)
		case *ast.BLangTrapExpr:
			if conditional > 0 {
				reason = "Error operators in conditionally evaluated operands are not modeled."
			}
			scan(n.Expr, expand)
		case *ast.BLangTemplateExpr:
			if n.Kind != ast.TemplateExprKindString {
				reason = "Non-string template evaluation is not modeled."
				break
			}
			for _, e := range n.Insertions {
				scan(e, expand)
			}

		default:
			reason = fmt.Sprintf("Control effects of %T are not modeled; later source may still execute.", expr)
		}
	}
	scan(expr, safe)
	return calls, reason
}
func legacyServicePath(service *ast.BLangService) string {
	if service.AbsoluteResourcePath != nil {
		parts := []string{}
		for _, part := range service.AbsoluteResourcePath {
			parts = append(parts, part.Value)
		}
		return "/" + strings.Join(parts, "/")
	}
	if service.AttachPointLiteral != nil {
		return service.AttachPointLiteral.OriginalValue
	}
	return ""
}

// Symbol identity prevents shadowed clients from sharing constructor context. A
// mutable global or any reassigned receiver deliberately has no initializer hint.
func (p *legacyExtractor) collectReceiverContexts() {
	p.receiverContexts = map[model.SymbolRef]ReceiverContextModel{}
	written := map[model.SymbolRef]bool{}
	globals := map[model.SymbolRef]bool{}
	params := map[model.SymbolRef]bool{}
	var vars []*ast.BLangVariable
	for _, mod := range p.modules {
		if !mod.workspace {
			continue
		}
		for _, v := range mod.pkg.GlobalVars {
			globals[v.Symbol()] = true
		}
		ast.Walk(sourceVisitor(func(n ast.BLangNode) bool {
			if fn, ok := n.(ast.InvokableNode); ok {
				for _, v := range fn.GetParameters() {
					params[v.Symbol()] = true
				}
			}
			switch n := n.(type) {
			case *ast.BLangVariable:
				vars = append(vars, n)
			case *ast.BLangAssignment:
				if v, ok := n.VarRef.(*ast.BLangVarRef); ok {
					written[v.Symbol()] = true
				}
			case *ast.BLangCompoundAssignment:
				if v, ok := n.VarRef.(*ast.BLangVarRef); ok {
					written[v.Symbol()] = true
				}
			}
			return true
		}), mod.pkg)
	}
	for i, v := range vars {
		if v.Symbol().IsEmpty() {
			continue
		}
		context := ReceiverContextModel{Origin: "unavailable"}
		if ty := v.TypeNode(); ty != nil && !v.IsDeclaredWithVar {
			context.Type = p.located(fmt.Sprintf("receiver/%d/type", i), ty).Text
		}
		if params[v.Symbol()] {
			context.Origin = "parameter"
		}
		if !params[v.Symbol()] && v.Expr != nil && !written[v.Symbol()] && (!globals[v.Symbol()] || v.Flags()&model.FlagFinal != 0) {
			init := p.located(fmt.Sprintf("receiver/%d/initializer", i), v.Expr)
			context.Initializer = &init
			context.Origin = "initializer"
			expr := v.Expr
			for {
				switch n := expr.(type) {
				case *ast.BLangCheckedExpr:
					expr = n.Expr
				case *ast.BLangCheckPanickedExpr:
					expr = n.Expr
				case *ast.BLangGroupExpr:
					expr = n.Expression
				default:
					goto unwrapped
				}
			}
		unwrapped:
			if _, ok := expr.(*ast.BLangNewExpression); ok {
				context.Origin = "constructor"
			}
		}
		p.receiverContexts[v.Symbol()] = context
	}
}

func (p *legacyExtractor) clientInvocation(id string, call ast.Invocable) *ClientInvocationModel {
	receiver := call.Receiver()
	if receiver == nil {
		return nil
	}
	var context ReceiverContextModel
	isClient := false
	switch call.(type) {
	case *ast.BLangRemoteMethodCallAction, *ast.BLangClientResourceAccessAction:
		isClient = true
	}
	if ref, ok := receiver.(*ast.BLangVarRef); ok {
		context = p.receiverContexts[ref.Symbol()]
		if !ref.Symbol().IsEmpty() {
			isClient = isClient || semtypes.IsClientObject(semtypes.ContextFrom(p.env.GetTypeEnv()), p.env.SymbolType(ref.Symbol()))
		}
	}
	if !isClient {
		return nil
	}
	context.Receiver = p.located(id+"/receiver", receiver)
	if context.Origin == "" {
		context.Origin = "unavailable"
	}
	method := ""
	switch n := call.(type) {
	case *ast.BLangInvocation:
		method = n.Name.GetValue()
	case *ast.BLangRemoteMethodCallAction:
		method = n.Name.GetValue()
	case *ast.BLangClientResourceAccessAction:
		// Keep resource path segments exactly as written rather than treating them
		// as constructor-relative HTTP paths.
		text := p.located(id, call).Text
		receiverPos, callPos := receiver.GetPosition(), call.GetPosition()
		start := receiverPos.EndOffset() - callPos.StartOffset()
		if start >= 0 && start <= len(text) {
			method = strings.TrimSpace(text[start:])
		}
	}
	args := []LocatedModel{}
	for i, arg := range p.callArgs(call) {
		args = append(args, p.located(fmt.Sprintf("%s/argument/%d", id, i), arg))
	}
	return &ClientInvocationModel{Context: context, Method: method, Arguments: args}
}

// Evaluation preserves operator nesting. Composite source expressions retain
// their exact text while exposing only the nested evaluations needing a view.
func (p *legacyExtractor) evaluation(id string, expr ast.BLangActionOrExpression, calls []CallSiteModel) *EvaluationModel {
	if expr == nil {
		return nil
	}
	e := EvaluationModel{LocatedModel: p.located(id, expr), Kind: "source", Children: []EvaluationModel{}}
	add := func(child ast.BLangActionOrExpression) {
		if c := p.evaluation(fmt.Sprintf("%s/part/%d", id, len(e.Children)), child, calls); c != nil {
			e.Children = append(e.Children, *c)
		}
	}
	if call, ok := expr.(ast.Invocable); ok {
		for i := range calls {
			if calls[i].Source == e.Source {
				c := calls[i]
				e.Call = &c
				break
			}
		}
		if call.Receiver() != nil {
			add(call.Receiver())
		}
		for _, segment := range resourcePathExpressions(call) {
			add(segment)
		}
		for _, arg := range p.callArgs(call) {
			add(arg)
		}
		if e.Call != nil {
			e.Kind = "call"
		}
	} else {
		switch n := expr.(type) {
		case *ast.BLangCheckedExpr:
			e.Kind = "check"
			add(n.Expr)
		case *ast.BLangCheckPanickedExpr:
			e.Kind = "checkpanic"
			add(n.Expr)
		case *ast.BLangTrapExpr:
			e.Kind = "trap"
			add(n.Expr)
		case *ast.BLangGroupExpr:
			return p.evaluation(id, n.Expression, calls)
		case *ast.BLangTemplateExpr:
			if n.Kind == ast.TemplateExprKindString {
				e.Kind = "template"
				e.Strings = n.Strings
				for _, insertion := range n.Insertions {
					c := p.evaluation(fmt.Sprintf("%s/insertion/%d", id, len(e.Children)), insertion, calls)
					if c == nil {
						c = &EvaluationModel{LocatedModel: p.located(fmt.Sprintf("%s/insertion/%d", id, len(e.Children)), insertion), Kind: "source", Children: []EvaluationModel{}}
					}
					e.Children = append(e.Children, *c)
				}
			}
		case *ast.BLangBinaryExpr:
			if n.OpKind == model.OperatorKind_AND || n.OpKind == model.OperatorKind_OR {
				return nil
			}
			add(n.LhsExpr)
			add(n.RhsExpr)
		case *ast.BLangUnaryExpr:
			add(n.Expr)
		case *ast.BLangFieldBaseAccess:
			add(n.Expr)
		case *ast.BLangIndexBasedAccess:
			add(n.Expr)
			add(n.IndexExpr)
		case *ast.BLangNamedArgsExpression:
			add(n.Expr)
		case *ast.BLangListConstructorExpr:
			for _, x := range n.Exprs {
				add(x)
			}
		case *ast.BLangMappingConstructorExpr:
			for _, field := range n.Fields {
				if f, ok := field.(*ast.BLangMappingKeyValueField); ok {
					if f.Key != nil {
						add(f.Key.Expr)
					}
					add(f.ValueExpr)
				}
			}
		case *ast.BLangNewExpression:
			for _, x := range p.newArgs(n) {
				add(x)
			}
		case *ast.BLangTypeTestExpr:
			add(n.Expr)
		}
	}
	if (e.Kind == "check" || e.Kind == "checkpanic" || e.Kind == "trap") && len(e.Children) == 0 {
		var operand ast.BLangActionOrExpression
		switch n := expr.(type) {
		case *ast.BLangCheckedExpr:
			operand = n.Expr
		case *ast.BLangCheckPanickedExpr:
			operand = n.Expr
		case *ast.BLangTrapExpr:
			operand = n.Expr
		}
		e.Children = append(e.Children, EvaluationModel{LocatedModel: p.located(id+"/operand", operand), Kind: "source", Children: []EvaluationModel{}})
	}
	if e.Kind == "source" && len(e.Children) == 0 {
		return nil
	}
	// Ordinary function calls retain the existing renderer unless enclosed by a
	// newly modeled expression. This avoids changing their expansion behavior.
	return &e
}

func hasEvaluation(e *EvaluationModel) bool {
	if e == nil {
		return false
	}
	if e.Kind == "check" || e.Kind == "checkpanic" || e.Kind == "trap" || e.Kind == "template" || (e.Call != nil && e.Call.Client != nil) {
		return true
	}
	for i := range e.Children {
		if hasEvaluation(&e.Children[i]) {
			return true
		}
	}
	return false
}
func (p *legacyExtractor) renderedEvaluation(id string, expr ast.BLangActionOrExpression, calls []CallSiteModel) *EvaluationModel {
	e := p.evaluation(id, expr, calls)
	if !hasEvaluation(e) {
		return nil
	}
	return e
}

func (p *legacyExtractor) callArgs(call ast.Invocable) []ast.BLangExpression {
	if args, ok := p.sourceCallArgs[call]; ok {
		return args
	}
	return call.CallArgs()
}
func (p *legacyExtractor) newArgs(expr *ast.BLangNewExpression) []ast.BLangExpression {
	if args, ok := p.sourceNewArgs[expr]; ok {
		return args
	}
	return expr.ArgsExprs
}

// An assignment may evaluate a computed target before evaluating its value.
// Retain those calls when the value switches to the structured renderer.
func (p *legacyExtractor) statementEvaluation(id string, statement ast.Node, lhs ast.BLangExpression, rhs ast.BLangActionOrExpression, calls []CallSiteModel) *EvaluationModel {
	value := p.evaluation(id+"/value", rhs, calls)
	target := p.evaluation(id+"/target", lhs, calls)
	if !hasEvaluation(value) && !hasEvaluation(target) {
		return nil
	}
	if target == nil {
		return value
	}
	children := []EvaluationModel{*target}
	if value != nil {
		children = append(children, *value)
	}
	return &EvaluationModel{LocatedModel: p.located(id+"/evaluation", statement), Kind: "source", Children: children}
}

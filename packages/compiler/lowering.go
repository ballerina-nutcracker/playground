package compiler

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/model"
	"github.com/ballerina-nutcracker/ballerina/semtypes"
)

// All mutable construction state belongs to one lowering invocation. The resolved
// frontend and its original argument snapshots remain read-only.
type lowerer struct {
	p                *resolvedProgram
	variables        map[string][]sourceVariableOccurrence
	sources          HIRRecord[LocatedModel]
	functionIDs      map[model.SymbolRef]string
	availableBodies  map[string]bool
	functions        []sourceFunctionEntry
	serviceIDs       map[*ast.BLangService]string
	receiverContexts map[model.SymbolRef]receiverContext
}
type sourceFunction interface {
	ast.InvokableNode
	Symbol() model.SymbolRef
	IsAttached() bool
	IsRemote() bool
}

type sourceFunctionEntry struct {
	node                sourceFunction
	moduleID, id, owner string
}
type receiverContext struct {
	receiver         LocatedModel
	typeText, origin string
	initializer      *LocatedModel
}
type callTarget struct{ kind, functionID, label string }
type clientPresentation struct{ presentation HIRPresentation }

func lowerProgram(p *resolvedProgram) (HIRProgram, error) {
	return lowerProgramMode(p, false)
}

func lowerProgramMode(p *resolvedProgram, functionViews bool) (HIRProgram, error) {
	l := &lowerer{p: p, sources: HIRRecord[LocatedModel]{}}
	l.collectVariables()
	functions, err := l.collectFunctions()
	if err != nil {
		return HIRProgram{}, err
	}
	if err := l.collectReceiverContexts(); err != nil {
		return HIRProgram{}, err
	}
	scopes, err := l.lowerScopes()
	if err != nil {
		return HIRProgram{}, err
	}
	result := HIRProgram{Scopes: scopes, Sources: l.sources, Functions: HIRRecord[HIRGraph]{}}
	for _, fn := range functions {
		graph, err := l.lowerFunction(fn)
		if err != nil {
			return HIRProgram{}, fmt.Errorf("lower %s: %w", fn.id, err)
		}
		result.Functions[fn.id] = graph
	}
	if !functionViews {
		return result, nil
	}
	result.FunctionViews = HIRRecord[HIRGraph]{}
	for _, fn := range functions {
		graph, err := l.lowerFunctionMode(fn, true)
		if err != nil {
			return HIRProgram{}, fmt.Errorf("lower function view %s: %w", fn.id, err)
		}
		result.FunctionViews[fn.id] = graph
	}
	return result, nil
}

func (l *lowerer) located(id string, node ast.Node) (LocatedModel, error) {
	if node == nil {
		return LocatedModel{}, fmt.Errorf("%s: missing source node", id)
	}
	location := node.GetPosition()
	ref, err := sourceReference(l.p.files, l.p.env.DiagnosticEnv(), location)
	if err != nil {
		return LocatedModel{}, fmt.Errorf("%s: %w", id, err)
	}
	text := l.p.files[ref.File]
	start, end := location.StartOffset(), location.EndOffset()
	if start < 0 || end < start || end > len(text) {
		return LocatedModel{}, fmt.Errorf("%s: invalid source offsets", id)
	}
	value := LocatedModel{ID: id, Source: ref, Text: text[start:end]}
	if l.sources == nil {
		l.sources = HIRRecord[LocatedModel]{}
	}
	if previous, exists := l.sources[id]; exists && previous != value {
		return LocatedModel{}, fmt.Errorf("conflicting source identity %q", id)
	}
	l.sources[id] = value
	return value, nil
}

func (l *lowerer) collectFunctions() ([]sourceFunctionEntry, error) {
	l.functionIDs = map[model.SymbolRef]string{}
	l.availableBodies = map[string]bool{}
	l.serviceIDs = map[*ast.BLangService]string{}
	l.functions = nil
	seen := map[string]bool{}
	add := func(fn sourceFunction, moduleID, id, owner string) error {
		if seen[id] {
			return fmt.Errorf("duplicate function identity %q", id)
		}
		seen[id] = true
		l.functionIDs[fn.Symbol()] = id
		switch fn.GetBody().(type) {
		case *ast.BLangBlockFunctionBody, *ast.BLangExprFunctionBody:
			l.availableBodies[id] = true
		}
		l.functions = append(l.functions, sourceFunctionEntry{fn, moduleID, id, owner})
		return nil
	}
	for _, mod := range l.p.modules {
		if !mod.workspace {
			continue
		}
		moduleID := mod.module.Descriptor().Org().Value() + "/" + mod.module.ModuleName().String()
		for _, fn := range mod.pkg.Functions {
			if err := add(fn, moduleID, moduleID+"/function/"+fn.Name.GetValue(), ""); err != nil {
				return nil, err
			}
		}
		for _, class := range mod.pkg.ClassDefinitions {
			names := []string{}
			for name := range class.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				if err := add(class.Methods[name], moduleID, moduleID+"/class/"+class.Name.GetValue()+"/method/"+name, class.Name.GetValue()); err != nil {
					return nil, err
				}
			}
			for _, fn := range class.ResourceMethods {
				signature, err := resourceSignature(l, fn)
				if err != nil {
					return nil, err
				}
				if err := add(fn, moduleID, moduleID+"/class/"+class.Name.GetValue()+"/resource/"+signature, class.Name.GetValue()); err != nil {
					return nil, err
				}
			}
		}
		counts := map[string]int{}
		for _, service := range mod.pkg.Services {
			key := moduleID + "/service/" + l.p.env.DiagnosticEnv().FileName(service.GetPosition()) + "/" + servicePath(service)
			counts[key]++
			id := fmt.Sprintf("%s/%d", key, counts[key])
			l.serviceIDs[service] = id
			names := []string{}
			for name := range service.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				if err := add(service.Methods[name], moduleID, id+"/method/"+name, ""); err != nil {
					return nil, err
				}
			}
			for _, fn := range service.ResourceMethods {
				signature, err := resourceSignature(l, fn)
				if err != nil {
					return nil, err
				}
				if err := add(fn, moduleID, id+"/resource/"+signature, ""); err != nil {
					return nil, err
				}
			}
		}
	}
	return l.functions, nil
}

func resourcePath(l *lowerer, fn *ast.BLangResourceMethod) (string, error) {
	parts := []string{}
	// Source-position keys are available even while function identities are being
	// collected. Unlike the old shared "path" ID these cannot alias other methods.
	for i := range fn.ResourcePath {
		node := &fn.ResourcePath[i]
		position := fn.GetPosition()
		id := fmt.Sprintf("resource-path/%s/%d/%d", l.p.env.DiagnosticEnv().FileName(position), position.StartOffset(), i)
		value, err := l.located(id, node)
		if err != nil {
			return "", err
		}
		parts = append(parts, value.Text)
	}
	return strings.Join(parts, "/"), nil
}
func resourceSignature(l *lowerer, fn *ast.BLangResourceMethod) (string, error) {
	path, err := resourcePath(l, fn)
	if err != nil {
		return "", err
	}
	return fn.Name.GetValue() + "/" + path, nil
}

func (l *lowerer) lowerEntry(fn sourceFunctionEntry) (HIREntry, error) {
	entry := HIREntry{Kind: HIREntryKindFunction, Name: strings.TrimPrefix(fn.node.GetName().GetValue(), "$remote$"), Parameters: HIRList[HIREntryParameter]{}, ReturnType: "()"}
	if fn.node.IsAttached() {
		entry.Kind = HIREntryKindMethod
	}
	if fn.owner != "" {
		entry.Name = fn.owner + "." + entry.Name
	}
	if fn.node.IsRemote() {
		entry.Kind = HIREntryKindRemote
	}
	if resource, ok := fn.node.(*ast.BLangResourceMethod); ok {
		entry.Kind = HIREntryKindResource
		path, err := resourcePath(l, resource)
		if err != nil {
			return HIREntry{}, err
		}
		operation := resource.Name.GetValue()
		entry.Operation = &operation
		entry.Name = "/" + path
		for i := range resource.ResourcePath {
			segment := &resource.ResourcePath[i]
			if segment.Kind != ast.ResourcePathSegmentName {
				value, err := l.located(fmt.Sprintf("%s/path/%d", fn.id, i), segment)
				if err != nil {
					return HIREntry{}, err
				}
				entry.Parameters = append(entry.Parameters, HIREntryParameter{Label: HIRParameterLabelPath, Text: value.Text, Variables: l.locatedVariables(value)})
			}
		}
	}
	for i, param := range fn.node.GetParameters() {
		value, err := l.located(fmt.Sprintf("%s/parameter/%d", fn.id, i), &param)
		if err != nil {
			return HIREntry{}, err
		}
		entry.Parameters = append(entry.Parameters, HIREntryParameter{Label: HIRParameterLabelInput, Text: value.Text, Variables: l.locatedVariables(value)})
	}
	if param := fn.node.GetRestParam(); param != nil {
		value, err := l.located(fn.id+"/rest", param)
		if err != nil {
			return HIREntry{}, err
		}
		entry.Parameters = append(entry.Parameters, HIREntryParameter{Label: HIRParameterLabelInput, Text: value.Text, Variables: l.locatedVariables(value)})
	}
	if descriptor := fn.node.GetReturnTypeDescriptor(); fn.node.HasExplicitReturnTypeDescriptor() && descriptor != nil {
		value, err := l.located(fn.id+"/returnType", descriptor)
		if err != nil {
			return HIREntry{}, err
		}
		entry.ReturnType = value.Text
	}
	value, err := l.located(fn.id, fn.node)
	if err != nil {
		return HIREntry{}, err
	}
	position := fn.node.GetPosition()
	end := position.EndOffset()
	if fn.node.HasBody() {
		bodyPosition := fn.node.GetBody().GetPosition()
		end = bodyPosition.StartOffset()
	}
	start := position.StartOffset()
	if end < start || end > position.EndOffset() {
		return HIREntry{}, fmt.Errorf("%s: invalid signature source range", fn.id)
	}
	rawSignature := l.p.files[value.Source.File][start:end]
	entry.Signature = strings.TrimSpace(rawSignature)
	signatureStart := start + strings.Index(rawSignature, entry.Signature)
	entry.SignatureVariables = l.variablesIn(value.Source.File, signatureStart, signatureStart+len(entry.Signature))
	// Entry cards use the discovery title (including the service base path),
	// not the function's local resource name. Store the already split heading.
	scopes, err := l.lowerScopes()
	if err != nil {
		return HIREntry{}, err
	}
	for _, scope := range scopes {
		if scope.Kind != "service" || scope.Endpoints == nil {
			continue
		}
		for _, endpoint := range *scope.Endpoints {
			if endpoint.FunctionID != fn.id {
				continue
			}
			owner := "Service " + scope.Title
			if scope.ServiceType != nil && !strings.Contains(scope.Title, *scope.ServiceType) {
				owner += " · " + *scope.ServiceType
			}
			entry.Owner = &owner
			entry.Name = endpoint.Title
			if entry.Kind == HIREntryKindResource {
				if separator := strings.IndexByte(endpoint.Title, ' '); separator > 0 {
					operation := endpoint.Title[:separator]
					entry.Operation = &operation
					entry.Name = endpoint.Title[separator+1:]
				}
			}
		}
	}
	return entry, nil
}

func (l *lowerer) lowerScopes() ([]ScopeModel, error) {
	scopes := []ScopeModel{}
	for _, mod := range l.p.modules {
		if !mod.workspace {
			continue
		}
		moduleID := mod.module.Descriptor().Org().Value() + "/" + mod.module.ModuleName().String()
		definitions := []DefinitionModel{}
		for _, fn := range mod.pkg.Functions {
			id := l.functionIDs[fn.Symbol()]
			value, err := l.located(id, fn)
			if err != nil {
				return nil, err
			}
			definitions = append(definitions, DefinitionModel{LocatedModel: value, Kind: "function", Label: fn.Name.GetValue(), FunctionID: id})
		}
		for _, ty := range mod.pkg.TypeDefinitions {
			value, err := l.located(moduleID+"/type/"+ty.Name.GetValue(), ty)
			if err != nil {
				return nil, err
			}
			definitions = append(definitions, DefinitionModel{LocatedModel: value, Kind: "type", Label: ty.Name.GetValue()})
		}
		typeContext := semtypes.ContextFrom(l.p.env.GetTypeEnv())
		connector := func(v *ast.BLangVariable, owner string) (DefinitionModel, bool, error) {
			if !semtypes.IsClientObject(typeContext, l.p.env.SymbolType(v.Symbol())) {
				return DefinitionModel{}, false, nil
			}
			value, err := l.located(owner+"/connector/"+v.Name.GetValue(), v)
			if err != nil {
				return DefinitionModel{}, false, err
			}
			return DefinitionModel{LocatedModel: value, Kind: "connector", Label: v.Name.GetValue()}, true, nil
		}
		for _, v := range mod.pkg.GlobalVars {
			d, ok, err := connector(v, moduleID)
			if err != nil {
				return nil, err
			}
			if ok {
				definitions = append(definitions, d)
			}
		}
		for _, service := range mod.pkg.Services {
			id := l.serviceIDs[service]
			defs := append([]DefinitionModel{}, definitions...)
			endpoints := []EndpointModel{}
			names := []string{}
			for name := range service.Methods {
				names = append(names, name)
			}
			slices.Sort(names)
			path := servicePath(service)
			for _, name := range names {
				fn := service.Methods[name]
				fid := l.functionIDs[fn.Symbol()]
				value, err := l.located(fid, fn)
				if err != nil {
					return nil, err
				}
				if fn.IsRemote() {
					endpoints = append(endpoints, EndpointModel{LocatedModel: value, Kind: "remote", Title: strings.TrimPrefix(name, "$remote$"), FunctionID: fid})
				} else {
					defs = append(defs, DefinitionModel{LocatedModel: value, Kind: "function", Label: name, FunctionID: fid})
				}
			}
			for _, fn := range service.ResourceMethods {
				fid := l.functionIDs[fn.Symbol()]
				resource, err := resourcePath(l, fn)
				if err != nil {
					return nil, err
				}
				title := fn.Name.GetValue() + " " + strings.TrimRight(path, "/") + "/" + resource
				value, err := l.located(fid, fn)
				if err != nil {
					return nil, err
				}
				endpoints = append(endpoints, EndpointModel{LocatedModel: value, Kind: "resource", Title: title, FunctionID: fid})
			}
			for _, v := range service.Fields {
				d, ok, err := connector(v, id)
				if err != nil {
					return nil, err
				}
				if ok {
					defs = append(defs, d)
				}
			}
			var serviceType *string
			for _, expr := range service.AttachedExprs {
				if n, ok := expr.(*ast.BLangNewExpression); ok && !n.ClassSymbol.IsEmpty() {
					pkg := l.p.env.SymbolPackage(n.ClassSymbol)
					label := pkg.Organization + "/" + pkg.Package + ":" + l.p.env.SymbolName(n.ClassSymbol)
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
			value, err := l.located(id, service)
			if err != nil {
				return nil, err
			}
			scopes = append(scopes, ScopeModel{LocatedModel: value, Kind: "service", Title: title, ModuleID: moduleID, ServiceType: serviceType, Endpoints: &endpoints, Definitions: &defs})
		}
	}
	if len(scopes) == 0 {
		for _, fn := range l.functions {
			if fn.node.GetName().GetValue() == "main" && !fn.node.IsAttached() {
				value, err := l.located(fn.id, fn.node)
				if err != nil {
					return nil, err
				}
				scopes = append(scopes, ScopeModel{LocatedModel: value, Kind: "automation", Title: "Automation", ModuleID: fn.moduleID, FunctionID: fn.id})
			}
		}
	}
	slices.SortFunc(scopes, func(a, b ScopeModel) int { return strings.Compare(a.ID, b.ID) })
	titles := map[string]int{}
	for _, scope := range scopes {
		if scope.Kind == "service" {
			titles[scope.Title]++
		}
	}
	for i := range scopes {
		scope := &scopes[i]
		if scope.Kind == "service" && titles[scope.Title] > 1 {
			scope.Title += " · " + scope.ModuleID + " · " + scope.Source.File + fmt.Sprintf(":%d", scope.Source.Range.Start.Line)
		}
	}
	return scopes, nil
}

func (l *lowerer) callArgs(call ast.Invocable) []ast.BLangExpression {
	if args, ok := l.p.sourceCallArgs[call]; ok {
		return args
	}
	return call.CallArgs()
}
func (l *lowerer) newArgs(expr *ast.BLangNewExpression) []ast.BLangExpression {
	if args, ok := l.p.sourceNewArgs[expr]; ok {
		return args
	}
	return expr.ArgsExprs
}
func (l *lowerer) resolveCallTarget(call ast.Invocable) (callTarget, error) {
	symbol := call.ResolvedSymbol()
	if symbol.IsEmpty() {
		return callTarget{}, fmt.Errorf("unresolved invocation")
	}
	if id, ok := l.functionIDs[symbol]; ok {
		return callTarget{kind: "workspace", functionID: id}, nil
	}
	return callTarget{kind: "external", label: l.p.env.SymbolName(symbol)}, nil
}

func (l *lowerer) collectReceiverContexts() error {
	l.receiverContexts = map[model.SymbolRef]receiverContext{}
	written, globals, params := map[model.SymbolRef]bool{}, map[model.SymbolRef]bool{}, map[model.SymbolRef]bool{}
	var vars []*ast.BLangVariable
	for _, mod := range l.p.modules {
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
	// Preserve the legacy walk order for initializer identities. In particular,
	// package functions precede class methods even when declared later in source.
	// Type-only identities are new to HIR and use positions instead: method maps
	// can change their traversal order without changing those identities.
	for i, v := range vars {
		if v.Symbol().IsEmpty() {
			continue
		}
		context := receiverContext{origin: "unavailable"}
		if ty := v.TypeNode(); ty != nil && !v.IsDeclaredWithVar {
			position := v.GetPosition()
			id := fmt.Sprintf("receiver/%s/%d/%d/type", l.p.env.DiagnosticEnv().FileName(position), position.StartOffset(), position.EndOffset())
			value, err := l.located(id, ty)
			if err != nil {
				return err
			}
			context.typeText = value.Text
		}
		if params[v.Symbol()] {
			context.origin = "parameter"
		}
		if !params[v.Symbol()] && v.Expr != nil && !written[v.Symbol()] && (!globals[v.Symbol()] || v.Flags()&model.FlagFinal != 0) {
			value, err := l.located(fmt.Sprintf("receiver/%d/initializer", i), v.Expr)
			if err != nil {
				return err
			}
			context.initializer = &value
			context.origin = "initializer"
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
				context.origin = "constructor"
			}
		}
		l.receiverContexts[v.Symbol()] = context
	}
	return nil
}

func (l *lowerer) clientPresentation(id string, call ast.Invocable) (*clientPresentation, error) {
	receiver := call.Receiver()
	if receiver == nil {
		return nil, nil
	}
	context := receiverContext{origin: "unavailable"}
	isClient := false
	switch call.(type) {
	case *ast.BLangRemoteMethodCallAction, *ast.BLangClientResourceAccessAction:
		isClient = true
	}
	if ref, ok := receiver.(*ast.BLangVarRef); ok {
		context = l.receiverContexts[ref.Symbol()]
		if !ref.Symbol().IsEmpty() {
			isClient = isClient || semtypes.IsClientObject(semtypes.ContextFrom(l.p.env.GetTypeEnv()), l.p.env.SymbolType(ref.Symbol()))
		}
	}
	if !isClient {
		return nil, nil
	}
	value, err := l.located(id+"/receiver", receiver)
	if err != nil {
		return nil, err
	}
	context.receiver = value
	method := ""
	methodVariables := HIRList[HIRVariableOccurrence]{}
	switch n := call.(type) {
	case *ast.BLangInvocation:
		method = n.Name.GetValue()
	case *ast.BLangRemoteMethodCallAction:
		method = n.Name.GetValue()
	case *ast.BLangClientResourceAccessAction:
		value, err := l.located(id, call)
		if err != nil {
			return nil, err
		}
		receiverPosition, callPosition := receiver.GetPosition(), call.GetPosition()
		start := receiverPosition.EndOffset() - callPosition.StartOffset()
		if start >= 0 && start <= len(value.Text) {
			raw := value.Text[start:]
			method = strings.TrimSpace(raw)
			methodStart := receiverPosition.EndOffset() + strings.Index(raw, method)
			methodVariables = l.variablesIn(value.Source.File, methodStart, methodStart+len(method))
		}
	}
	args := []string{}
	argumentVariables := HIRList[HIRVariableOccurrence]{}
	argumentOffset := 0
	for i, arg := range l.callArgs(call) {
		value, err := l.located(fmt.Sprintf("%s/argument/%d", id, i), arg)
		if err != nil {
			return nil, err
		}
		argumentVariables = append(argumentVariables, shiftedVariables(l.locatedVariables(value), argumentOffset)...)
		argumentOffset += utf16Length(value.Text) + 2
		args = append(args, value.Text)
	}
	if !strings.HasPrefix(method, "->") {
		methodVariables = shiftedVariables(argumentVariables, utf16Length("→ "+method+"("))
		method = "→ " + method + "(" + strings.Join(args, ", ") + ")"
	}
	heading := context.receiver.Text
	if context.typeText != "" {
		heading += " · " + context.typeText
	}
	text := "Initialization not statically known"
	if context.initializer != nil {
		text = context.initializer.Text
	} else if context.origin == "parameter" {
		text = "Parameter"
	}
	// JavaScript's original length/slice operate on UTF-16 code units.
	summary, truncated := clientContextSummary(text)
	content := func(summary string) HIRLabelContent {
		label := heading + "\n" + summary + "\n" + method
		variables := l.locatedVariables(context.receiver)
		if context.initializer != nil {
			for _, occurrence := range l.locatedVariables(*context.initializer) {
				limit := utf16Length(summary)
				if summary != text {
					limit--
				} // Ellipsis is not source text.
				if occurrence.End <= limit {
					variables = append(variables, shiftedVariables(HIRList[HIRVariableOccurrence]{occurrence}, utf16Length(heading)+1)...)
				}
			}
		}
		variables = append(variables, shiftedVariables(methodVariables, utf16Length(heading)+1+utf16Length(summary)+1)...)
		// The legacy header splits every line, including multiline source values.
		sections := HIRList[HIRLabelSection]{}
		lineOffset := 0
		for i, line := range strings.Split(label, "\n") {
			kind := HIRLabelSectionKindMethod
			if i == 0 {
				kind = HIRLabelSectionKindReceiver
			} else if i == 1 {
				kind = HIRLabelSectionKindContext
			}
			lineVariables := HIRList[HIRVariableOccurrence]{}
			for _, occurrence := range variables {
				if occurrence.Start >= lineOffset && occurrence.End <= lineOffset+utf16Length(line) {
					lineVariables = append(lineVariables, shiftedVariables(HIRList[HIRVariableOccurrence]{occurrence}, -lineOffset)...)
				}
			}
			sections = append(sections, HIRLabelSection{Kind: kind, Text: HIRText(line), Variables: lineVariables})
			lineOffset += utf16Length(line) + 1
		}
		return HIRLabelContent{Label: HIRText(label), Sections: sections, Variables: variables}
	}
	collapsed, expanded := content(summary), content(text)
	disclosure := HIRDisclosure{Value: HIRNoDisclosure{}}
	if truncated {
		disclosure.Value = HIRClientContextDisclosure{OccurrenceKey: id + "/context", Collapsed: collapsed, Expanded: expanded}
	}
	return &clientPresentation{presentation: HIRPresentation{Value: HIRClientPresentation{Style: HIRClientStyleClient, Label: collapsed.Label, Sections: collapsed.Sections, Variables: collapsed.Variables, Disclosure: disclosure}}}, nil
}

// Match JavaScript length > 90 and slice(0, 87), including a split astral pair.
func clientContextSummary(text string) (string, bool) {
	units := utf16.Encode([]rune(text))
	if len(units) <= 90 {
		return text, false
	}
	return string(hirTextFromUTF16(units[:87])) + "…", true
}

func servicePath(service *ast.BLangService) string {
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

package compiler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// ValidateHIR validates a complete graph collection without resolving or analyzing source.
func ValidateHIR(program HIRProgram) error {
	// Normalize sealed value/pointer variants on a private copy. This also rejects
	// nil variants and exercises the same strict codec used by bridge consumers.
	if err := hirUnicode(reflect.ValueOf(program)); err != nil {
		return err
	}
	data, err := json.Marshal(program)
	if err != nil {
		return fmt.Errorf("HIR: %w", err)
	}
	var p HIRProgram
	if err = json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("HIR: %w", err)
	}
	if err = hirEnums(reflect.ValueOf(p)); err != nil {
		return err
	}
	if err = hirVariableSpans(reflect.ValueOf(p)); err != nil {
		return err
	}
	if p.FunctionViews != nil {
		for id, graph := range p.FunctionViews {
			original, ok := p.Functions[id]
			if !ok || original.LocatedModel != graph.LocatedModel {
				return fmt.Errorf("function view %q: unknown or mismatched function", id)
			}
		}
		views := p
		views.Functions, views.FunctionViews = p.FunctionViews, nil
		if err := ValidateHIR(views); err != nil {
			return fmt.Errorf("function views: %w", err)
		}
	}
	for _, graph := range p.Functions {
		for _, node := range graph.Nodes {
			var label string
			switch presentation := node.Presentation.Value.(type) {
			case HIRPlainPresentation:
				label = string(presentation.Label)
			case HIRClientPresentation:
				label = string(presentation.Label)
			case *HIRPlainPresentation:
				label = string(presentation.Label)
			case *HIRClientPresentation:
				label = string(presentation.Label)
			}
			previous := 0
			for _, call := range node.Calls {
				if call.Start < previous || call.End <= call.Start || call.End > len(utf16.Encode([]rune(label))) || (call.TargetID == nil) == (call.Unavailable == nil) {
					return fmt.Errorf("node %q: invalid call span", node.ID)
				}
				if call.TargetID != nil {
					if *call.TargetID == "" {
						return fmt.Errorf("empty call target")
					}
					if _, ok := p.Functions[*call.TargetID]; !ok {
						return fmt.Errorf("unknown call target %q", *call.TargetID)
					}
				}
				if call.Unavailable != nil && *call.Unavailable == "" {
					return fmt.Errorf("empty call unavailability reason")
				}
				previous = call.End
			}
		}
	}
	v := hirValidator{program: p, graphs: map[string]*hirGraphIndex{}}
	for id, source := range p.Sources {
		if id == "" || source.ID != id {
			return fmt.Errorf("sources[%q]: source ID mismatch", id)
		}
		r := source.Source.Range
		if source.Source.File == "" || !hirSourcePosition(r.Start) || !hirSourcePosition(r.End) || r.End.Line < r.Start.Line || (r.End.Line == r.Start.Line && r.End.Column < r.Start.Column) {
			return fmt.Errorf("source %q: invalid range", id)
		}
	}
	keys := make([]string, 0, len(p.Functions))
	for id := range p.Functions {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		g := p.Functions[id]
		if id == "" || id != g.ID {
			return fmt.Errorf("graph %q: ID mismatch", id)
		}
		if err := v.located(g.LocatedModel); err != nil {
			return err
		}
		index, err := v.index(g)
		if err != nil {
			return fmt.Errorf("graph %q: %w", id, err)
		}
		v.graphs[id] = index
	}
	scopeIDs := map[string]bool{}
	endpointIDs := map[string]bool{}
	for _, scope := range p.Scopes {
		if scope.ModuleID == "" || scope.Title == "" {
			return fmt.Errorf("scope %q: empty module ID or title", scope.ID)
		}
		if scopeIDs[scope.ID] {
			return fmt.Errorf("duplicate scope %q", scope.ID)
		}
		scopeIDs[scope.ID] = true
		if scope.Kind == "automation" {
			if scope.Title != "Automation" || v.graphs[scope.FunctionID] == nil {
				return fmt.Errorf("scope %q: invalid automation", scope.ID)
			}
		} else if scope.Kind == "service" {
			if scope.FunctionID != "" || scope.Endpoints == nil || scope.Definitions == nil {
				return fmt.Errorf("scope %q: invalid service", scope.ID)
			}
		} else {
			return fmt.Errorf("scope %q: invalid kind", scope.ID)
		}
		if err := v.located(scope.LocatedModel); err != nil {
			return err
		}
		if scope.FunctionID != "" && v.graphs[scope.FunctionID] == nil {
			return fmt.Errorf("scope %q: unknown function", scope.ID)
		}
		if scope.Endpoints != nil {
			for _, endpoint := range *scope.Endpoints {
				if endpointIDs[endpoint.ID] || endpoint.Title == "" || (endpoint.Kind != "resource" && endpoint.Kind != "remote") {
					return fmt.Errorf("endpoint %q: duplicate, empty title or invalid kind", endpoint.ID)
				}
				endpointIDs[endpoint.ID] = true
				if err := v.located(endpoint.LocatedModel); err != nil {
					return err
				}
				if v.graphs[endpoint.FunctionID] == nil {
					return fmt.Errorf("endpoint %q: unknown function", endpoint.ID)
				}
			}
		}
		if scope.Definitions != nil {
			definitionIDs := map[string]bool{}
			for _, definition := range *scope.Definitions {
				if definitionIDs[definition.ID] || definition.Label == "" {
					return fmt.Errorf("definition %q: duplicate or empty label", definition.ID)
				}
				definitionIDs[definition.ID] = true
				if definition.Kind == "function" {
					if v.graphs[definition.FunctionID] == nil {
						return fmt.Errorf("definition %q: unknown function", definition.ID)
					}
				} else if (definition.Kind != "type" && definition.Kind != "connector" && definition.Kind != "configurable") || definition.FunctionID != "" {
					return fmt.Errorf("definition %q: invalid kind/function", definition.ID)
				}
				if err := v.located(definition.LocatedModel); err != nil {
					return err
				}
				if definition.FunctionID != "" && v.graphs[definition.FunctionID] == nil {
					return fmt.Errorf("definition %q: unknown function", definition.ID)
				}
			}
		}
	}
	for _, id := range keys {
		if err := v.links(v.graphs[id]); err != nil {
			return fmt.Errorf("graph %q: %w", id, err)
		}
	}
	for _, id := range keys {
		for _, inline := range []bool{false, true} {
			boolean := newHIRBoolean()
			instance := v.symbolicInstance(id, inline, map[string]bool{}, boolean)
			if err := instance.validate(); err != nil {
				return fmt.Errorf("graph %q (inline=%t): %w", id, inline, err)
			}
		}
	}
	return nil
}

// PrintHIR emits canonical JSON without changing array order or the input graph.
func PrintHIR(program HIRProgram) (string, error) {
	if err := ValidateHIR(program); err != nil {
		return "", err
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(program); err != nil {
		return "", err
	}
	return output.String(), nil
}

var hirEnumValues = map[string]string{
	"HIREntryKind": "resource remote function method", "HIRParameterLabel": "Path Input",
	"HIRNodeStyle":        "step condition function loop mapping unsupported return client trap panic template error-constructor",
	"HIRLabelSectionKind": "text receiver context method error-message error-cause error-detail template-type template-expression", "HIRClientStyle": "client",
	"HIRPortRole":   "entry normal-exit true false return break continue next-iteration panic",
	"HIRAnchorKind": "top-center header-left header-right header-bottom-center bottom-center group-bottom-center iteration-marker",
	"HIREdgeKind":   "sequence true false back break continue return error panic", "HIRRouting": "direct branch-left branch-right back",
	"HIRSpacingProfile": "sequence if while foreach trap root call",
}

// Check typed strings before json.Marshal can silently replace invalid bytes.
// HIRText has its own lossless UTF-16 codec and is deliberately exempt.
func hirUnicode(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	if value.Type() == reflect.TypeOf(HIRText("")) {
		return nil
	}
	switch value.Kind() {
	case reflect.String:
		if !utf8.ValidString(value.String()) {
			return fmt.Errorf("invalid Unicode in HIR string")
		}
	case reflect.Interface, reflect.Pointer:
		if !value.IsNil() {
			return hirUnicode(value.Elem())
		}
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if err := hirUnicode(value.Field(i)); err != nil {
				return err
			}
		}
	case reflect.Slice:
		for i := 0; i < value.Len(); i++ {
			if err := hirUnicode(value.Index(i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		for _, key := range value.MapKeys() {
			if err := hirUnicode(key); err != nil {
				return err
			}
			if err := hirUnicode(value.MapIndex(key)); err != nil {
				return err
			}
		}
	}
	return nil
}

func hirEnums(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return hirEnums(value.Elem())
	}
	if values, ok := hirEnumValues[value.Type().Name()]; ok {
		found := false
		for _, choice := range strings.Fields(values) {
			if value.String() == choice {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("invalid %s %q", value.Type().Name(), value.String())
		}
	}
	switch value.Kind() {
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if err := hirEnums(value.Field(i)); err != nil {
				return err
			}
		}
	case reflect.Slice:
		for i := 0; i < value.Len(); i++ {
			if err := hirEnums(value.Index(i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		for _, key := range value.MapKeys() {
			if err := hirEnums(value.MapIndex(key)); err != nil {
				return err
			}
		}
	}
	return nil
}

// Walk the normalized wire tree so every independent display alternative is
// checked, including nested client-context and recursive disclosures.
func hirVariableSpans(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return hirVariableSpans(value.Elem())
	}
	if value.Kind() == reflect.Struct {
		var text string
		var spans HIRList[HIRVariableOccurrence]
		switch v := value.Interface().(type) {
		case HIREntry:
			text, spans = v.Signature, v.SignatureVariables
		case HIREntryParameter:
			text, spans = v.Text, v.Variables
		case HIRLabelSection:
			text, spans = string(v.Text), v.Variables
		case HIRPlainPresentation:
			text, spans = string(v.Label), v.Variables
		case HIRClientPresentation:
			text, spans = string(v.Label), v.Variables
		case HIRLabelContent:
			text, spans = string(v.Label), v.Variables
		case HIRRecursivePresentation:
			text, spans = string(v.Label), v.Variables
		}
		if err := hirCheckVariableSpans(text, spans); err != nil {
			return fmt.Errorf("%s: %w", value.Type().Name(), err)
		}
		for i := 0; i < value.NumField(); i++ {
			if err := hirVariableSpans(value.Field(i)); err != nil {
				return err
			}
		}
	} else if value.Kind() == reflect.Slice {
		for i := 0; i < value.Len(); i++ {
			if err := hirVariableSpans(value.Index(i)); err != nil {
				return err
			}
		}
	} else if value.Kind() == reflect.Map {
		for _, key := range value.MapKeys() {
			if err := hirVariableSpans(value.MapIndex(key)); err != nil {
				return err
			}
		}
	}
	return nil
}

// Empty legacy template sections remain valid for historical HIR consumers.
func validateTemplateSections(style HIRNodeStyle, sections HIRList[HIRLabelSection]) error {
	for _, section := range sections {
		if section.Kind != HIRLabelSectionKindTemplateType && section.Kind != HIRLabelSectionKindTemplateExpression {
			continue
		}
		if style != HIRNodeStyleTemplate || len(sections) != 2 ||
			sections[0].Kind != HIRLabelSectionKindTemplateType ||
			sections[1].Kind != HIRLabelSectionKindTemplateExpression ||
			(sections[0].Text != "string" && sections[0].Text != "xml") {
			return fmt.Errorf("invalid template sections")
		}
	}
	return nil
}

func hirCheckVariableSpans(text string, spans HIRList[HIRVariableOccurrence]) error {
	length := utf16Length(text)
	// Consumers require source order as well as non-overlapping spans.
	end := 0
	for _, span := range spans {
		if strings.TrimSpace(span.VariableID) == "" {
			return fmt.Errorf("variable occurrence: empty variableId")
		}
		if span.Start < 0 || span.End <= span.Start || span.End > length {
			return fmt.Errorf("variable occurrence %q: invalid UTF-16 bounds [%d,%d) for length %d", span.VariableID, span.Start, span.End, length)
		}
		if span.Start < end {
			return fmt.Errorf("variable occurrence %q: unsorted or overlapping spans", span.VariableID)
		}
		end = span.End
	}
	return nil
}

type hirValidator struct {
	program HIRProgram
	graphs  map[string]*hirGraphIndex
}
type hirBindingInfo struct {
	id, reference, target, callerPort, callerInterface, kind string
	when                                                     HIRPresence
}
type hirGraphIndex struct {
	graph         HIRGraph
	nodes         map[string]HIRNode
	ports         map[string]HIRPort
	edges         map[string]HIREdge
	edgeReference map[string]string
	groups        map[string]HIRGroup
	interfaces    map[string]HIRInterface
	references    map[string]HIRGraphReference
	bindings      map[string]hirBindingInfo
	rootBindings  map[string]string
	preorder      []string
}

// Source coordinates cross the JSON boundary as JavaScript safe integers.
func hirSourcePosition(p Position) bool {
	const maxSafeInteger = 1<<53 - 1
	return p.Line >= 1 && int64(p.Line) <= maxSafeInteger && p.Column >= 1 && int64(p.Column) <= maxSafeInteger
}

func (v *hirValidator) located(item LocatedModel) error {
	source, ok := v.program.Sources[item.ID]
	if !ok || source != item {
		return fmt.Errorf("source %q: missing or inconsistent location/text", item.ID)
	}
	return nil
}
func hirUnique[T any](items map[string]T, id string, value T) error {
	if id == "" {
		return fmt.Errorf("empty ID")
	}
	if _, ok := items[id]; ok {
		return fmt.Errorf("duplicate ID %q", id)
	}
	items[id] = value
	return nil
}
func hirMembers(group HIRGroup) []string {
	switch a := group.Arrangement.Value.(type) {
	case *HIRSequenceArrangement:
		return a.Members
	case *HIRContainerArrangement:
		return a.Members
	case *HIRColumnsArrangement:
		return append(append([]string{}, a.Left...), a.Right...)
	}
	return nil
}
func (v *hirValidator) index(g HIRGraph) (*hirGraphIndex, error) {
	x := &hirGraphIndex{graph: g, nodes: map[string]HIRNode{}, ports: map[string]HIRPort{}, edges: map[string]HIREdge{}, edgeReference: map[string]string{}, groups: map[string]HIRGroup{}, interfaces: map[string]HIRInterface{}, references: map[string]HIRGraphReference{}, bindings: map[string]hirBindingInfo{}, rootBindings: map[string]string{}}
	if g.ModuleID == "" {
		return nil, fmt.Errorf("empty module ID")
	}
	// Retained entry metadata follows the legacy discovery-model constraints.
	// Nullable owner/operation strings may be empty; required display strings
	// and parameter text must be nonempty (whitespace is not normalized).
	if g.Entry.Name == "" || g.Entry.Signature == "" || g.Entry.ReturnType == "" {
		return nil, fmt.Errorf("entry: empty name, signature, or returnType")
	}
	for _, parameter := range g.Entry.Parameters {
		if parameter.Text == "" {
			return nil, fmt.Errorf("entry: empty parameter text")
		}
	}
	occurrences := map[string]bool{}
	disclosures := map[string]bool{}
	for _, n := range g.Nodes {
		if err := hirUnique(x.nodes, n.ID, n); err != nil {
			return nil, err
		}
		if n.OccurrenceKey == "" || occurrences[n.OccurrenceKey] {
			return nil, fmt.Errorf("node %q: duplicate/empty occurrenceKey", n.ID)
		}
		occurrences[n.OccurrenceKey] = true
		if _, ok := v.program.Sources[n.SourceID]; !ok {
			return nil, fmt.Errorf("node %q: missing source %q", n.ID, n.SourceID)
		}
		var disclosure HIRDisclosure
		switch presentation := n.Presentation.Value.(type) {
		case *HIRPlainPresentation:
			if err := validateTemplateSections(presentation.Style, presentation.Sections); err != nil {
				return nil, fmt.Errorf("node %q: %w", n.ID, err)
			}
			disclosure = presentation.Disclosure
		case *HIRClientPresentation:
			if err := validateTemplateSections(HIRNodeStyleClient, presentation.Sections); err != nil {
				return nil, fmt.Errorf("node %q: %w", n.ID, err)
			}
			disclosure = presentation.Disclosure
		}
		var call *HIRCallDisclosure
		keys := []string{}
		switch item := disclosure.Value.(type) {
		case *HIRCallDisclosure:
			call = item
		case *HIRClientContextDisclosure:
			if (item.Call == nil) != (item.ExpandedRecursive == nil) {
				return nil, fmt.Errorf("node %q: expanded recursive presentation requires call disclosure", n.ID)
			}
			keys = append(keys, item.OccurrenceKey)
			call = item.Call
		}
		body, reference := n.Body.Value.(*HIRReferenceBody)
		if _, client := n.Presentation.Value.(*HIRClientPresentation); client && reference && call == nil {
			return nil, fmt.Errorf("node %q: client reference missing call disclosure", n.ID)
		}
		if call != nil {
			keys = append(keys, call.OccurrenceKey)
			if !reference {
				return nil, fmt.Errorf("node %q: call disclosure without reference", n.ID)
			}
			left, _ := json.Marshal(call.Availability)
			right, _ := json.Marshal(body.Reference.Availability)
			if call.OccurrenceKey != body.Reference.OccurrenceKey || !bytes.Equal(left, right) {
				return nil, fmt.Errorf("node %q: call disclosure disagreement", n.ID)
			}
		}
		for _, key := range keys {
			if key == "" || disclosures[key] {
				return nil, fmt.Errorf("duplicate/empty disclosure occurrenceKey %q", key)
			}
			disclosures[key] = true
		}
		if b, ok := n.Body.Value.(*HIRReferenceBody); ok {
			x.references[n.ID] = b.Reference
			if b.Reference.OccurrenceKey == "" {
				return nil, fmt.Errorf("reference %q: empty occurrence", n.ID)
			}
			for id, other := range x.references {
				if id != n.ID && other.OccurrenceKey == b.Reference.OccurrenceKey {
					return nil, fmt.Errorf("reference %q: duplicate occurrence", n.ID)
				}
			}
		}
	}
	for _, p := range g.Ports {
		if p.OccurrenceKey == "" || occurrences[p.OccurrenceKey] {
			return nil, fmt.Errorf("port %q: duplicate/empty occurrenceKey", p.ID)
		}
		occurrences[p.OccurrenceKey] = true
		if err := hirUnique(x.ports, p.ID, p); err != nil {
			return nil, err
		}
		if _, ok := x.nodes[p.NodeID]; !ok {
			return nil, fmt.Errorf("port %q: missing owner", p.ID)
		}
	}
	for _, e := range g.Edges {
		if err := hirUnique(x.edges, e.ID, e); err != nil {
			return nil, err
		}
	}
	for node, r := range x.references {
		for _, e := range r.Collapsed.Edges {
			if err := hirUnique(x.edges, e.ID, e); err != nil {
				return nil, err
			}
			x.edgeReference[e.ID] = node
		}
	}
	for _, e := range x.edges {
		if _, ok := x.ports[e.FromPort]; !ok {
			return nil, fmt.Errorf("edge %q: missing from port", e.ID)
		}
		if _, ok := x.ports[e.ToPort]; !ok {
			return nil, fmt.Errorf("edge %q: missing to port", e.ID)
		}
	}
	for _, group := range g.Groups {
		if err := hirUnique(x.groups, group.ID, group); err != nil {
			return nil, err
		}
	}
	if _, ok := x.groups[g.RootGroup]; !ok {
		return nil, fmt.Errorf("missing root group")
	}
	owners := map[string]string{}
	groupOwners := map[string]string{}
	for _, group := range g.Groups {
		for _, id := range hirMembers(group) {
			if _, ok := x.nodes[id]; !ok {
				return nil, fmt.Errorf("group %q: missing node %q", group.ID, id)
			}
			if _, ok := owners[id]; ok {
				return nil, fmt.Errorf("node %q: multiple owners", id)
			}
			owners[id] = group.ID
		}
	}
	for _, node := range g.Nodes {
		if owners[node.ID] == "" {
			return nil, fmt.Errorf("node %q: no owner", node.ID)
		}
		if body, ok := node.Body.Value.(*HIRGroupBody); ok {
			if _, ok := x.groups[body.GroupID]; !ok {
				return nil, fmt.Errorf("node %q: missing group", node.ID)
			}
			if body.GroupID == g.RootGroup || groupOwners[body.GroupID] != "" {
				return nil, fmt.Errorf("group %q: multiple owners", body.GroupID)
			}
			groupOwners[body.GroupID] = node.ID
		}
	}
	for id := range x.groups {
		if id != g.RootGroup && groupOwners[id] == "" {
			return nil, fmt.Errorf("group %q: no owner", id)
		}
	}
	visiting := map[string]bool{}
	visited := map[string]bool{}
	var walk func(string) error
	walk = func(id string) error {
		if visiting[id] {
			return fmt.Errorf("group ownership cycle at %q", id)
		}
		if visited[id] {
			return nil
		}
		visiting[id] = true
		for _, node := range hirMembers(x.groups[id]) {
			x.preorder = append(x.preorder, node)
			if body, ok := x.nodes[node].Body.Value.(*HIRGroupBody); ok {
				if err := walk(body.GroupID); err != nil {
					return err
				}
			}
		}
		delete(visiting, id)
		visited[id] = true
		return nil
	}
	if err := walk(g.RootGroup); err != nil {
		return nil, err
	}
	if len(visited) != len(x.groups) {
		return nil, fmt.Errorf("disconnected group ownership cycle")
	}
	for _, i := range g.Interfaces {
		if err := hirUnique(x.interfaces, i.ID, i); err != nil {
			return nil, err
		}
		if root, ok := i.Root.Value.(*HIRConnectRoot); ok {
			if _, ok := x.ports[root.ToPort]; !ok {
				return nil, fmt.Errorf("root %q: missing target port", i.ID)
			}
			if err := hirUnique(x.rootBindings, root.BindingID, i.ID); err != nil {
				return nil, err
			}
		}
	}
	for node, r := range x.references {
		for _, binding := range r.Inline {
			b := hirBindingInfo{reference: node}
			switch item := binding.Value.(type) {
			case *HIREntryBinding:
				b.id = item.ID
				b.kind = "entry"
				b.target = item.TargetInterfaceID
				b.callerPort = item.CallerPortID
				b.when = item.When
			case *HIRExitBinding:
				b.id = item.ID
				b.kind = "exit"
				b.target = item.TargetInterfaceID
				b.callerPort = item.CallerPortID
				b.when = item.When
			case *HIRExportBinding:
				b.id = item.ID
				b.kind = "export"
				b.target = item.TargetInterfaceID
				b.callerInterface = item.CallerInterfaceID
				b.when = item.When
			}
			if _, ok := x.rootBindings[b.id]; ok {
				return nil, fmt.Errorf("duplicate binding %q", b.id)
			}
			if err := hirUnique(x.bindings, b.id, b); err != nil {
				return nil, err
			}
		}
	}
	return x, nil
}

func (v *hirValidator) links(x *hirGraphIndex) error {
	checkInterface := func(i HIRInterface, collapsed bool) error {
		for _, m := range i.Members {
			if _, ok := x.ports[m.PortID]; !ok {
				return fmt.Errorf("interface %q: missing port %q", i.ID, m.PortID)
			}
		}
		if collapsed {
			if len(i.Exports) > 0 {
				return fmt.Errorf("collapsed interface %q exports bindings", i.ID)
			}
			if _, terminal := i.Root.Value.(*HIRTerminalRoot); !terminal {
				return fmt.Errorf("collapsed interface %q has root connection", i.ID)
			}
		}
		return nil
	}
	for _, i := range x.interfaces {
		if err := checkInterface(i, false); err != nil {
			return err
		}
	}
	exports := map[string]bool{}
	for _, i := range x.interfaces {
		for _, e := range i.Exports {
			b, ok := x.bindings[e.BindingID]
			if !ok || b.kind != "export" || b.callerInterface != i.ID {
				return fmt.Errorf("interface %q: invalid export binding %q", i.ID, e.BindingID)
			}
			if e.BeforeMember < 0 || e.BeforeMember > len(i.Members) || exports[e.BindingID] {
				return fmt.Errorf("invalid/duplicate export %q", e.BindingID)
			}
			exports[e.BindingID] = true
		}
	}
	for node, r := range x.references {
		target := v.graphs[r.GraphID]
		if target == nil {
			return fmt.Errorf("reference %q: unknown graph %q", node, r.GraphID)
		}
		collapsed := map[string]HIRInterface{}
		for _, i := range r.Collapsed.Interfaces {
			if err := hirUnique(collapsed, i.ID, i); err != nil {
				return err
			}
			if err := checkInterface(i, true); err != nil {
				return err
			}
		}
		if target != nil {
			for id := range collapsed {
				if _, ok := target.interfaces[id]; !ok {
					return fmt.Errorf("reference %q: unknown collapsed interface %q", node, id)
				}
			}
		}
	}
	for _, b := range x.bindings {
		target := v.graphs[x.references[b.reference].GraphID]
		if target != nil {
			if _, ok := target.interfaces[b.target]; !ok {
				return fmt.Errorf("binding %q: missing target interface", b.id)
			}
		} else {
			found := false
			for _, i := range x.references[b.reference].Collapsed.Interfaces {
				if i.ID == b.target {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("binding %q: missing target interface", b.id)
			}
		}
		if b.kind == "export" {
			if _, ok := x.interfaces[b.callerInterface]; !ok || !exports[b.id] {
				return fmt.Errorf("binding %q: unlisted export", b.id)
			}
		} else if _, ok := x.ports[b.callerPort]; !ok {
			return fmt.Errorf("binding %q: missing caller port", b.id)
		}
	}
	// Traverse all expressions, even those masked by a false condition.
	var presence func(HIRPresence) error
	presence = func(p HIRPresence) error {
		switch a := p.Value.(type) {
		case *HIRAllPresence:
			for _, p := range a.Operands {
				if err := presence(p); err != nil {
					return err
				}
			}
		case *HIRAnyPresence:
			for _, p := range a.Operands {
				if err := presence(p); err != nil {
					return err
				}
			}
		case *HIRNotPresence:
			return presence(a.Operand)
		case *HIRNonemptyPresence:
			r, ok := x.references[a.ReferenceNodeID]
			if !ok {
				return fmt.Errorf("presence: %q is not a direct reference", a.ReferenceNodeID)
			}
			found := false
			for _, i := range r.Collapsed.Interfaces {
				if i.ID == a.InterfaceID {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("presence: unknown reference interface %q", a.InterfaceID)
			}
		}
		return nil
	}
	var expressions func(reflect.Value) error
	expressions = func(value reflect.Value) error {
		if !value.IsValid() {
			return nil
		}
		if value.Type() == reflect.TypeOf(HIRPresence{}) {
			return presence(value.Interface().(HIRPresence))
		}
		switch value.Kind() {
		case reflect.Pointer, reflect.Interface:
			if !value.IsNil() {
				return expressions(value.Elem())
			}
		case reflect.Struct:
			for i := 0; i < value.NumField(); i++ {
				if err := expressions(value.Field(i)); err != nil {
					return err
				}
			}
		case reflect.Slice:
			for i := 0; i < value.Len(); i++ {
				if err := expressions(value.Index(i)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := expressions(reflect.ValueOf(x.graph)); err != nil {
		return err
	}
	for _, plan := range []HIREmissionPlan{x.graph.Emission.Root, x.graph.Emission.Inline} {
		for stream, slots := range [][]HIREmission{plan.Nodes, plan.Ports, plan.Edges} {
			for _, slot := range slots {
				switch a := slot.Value.(type) {
				case *HIRLocalEmission:
					exists := false
					switch stream {
					case 0:
						_, exists = x.nodes[a.ItemID]
					case 1:
						_, exists = x.ports[a.ItemID]
					case 2:
						_, exists = x.edges[a.ItemID]
					}
					if !exists {
						return fmt.Errorf("emission: unknown local item %q", a.ItemID)
					}
				case *HIRChildEmission:
					if _, ok := x.references[a.ReferenceNodeID]; !ok {
						return fmt.Errorf("emission: unknown child %q", a.ReferenceNodeID)
					}
				case *HIRBindingEmission:
					if stream != 2 {
						return fmt.Errorf("binding emission outside edge stream")
					}
					_, b := x.bindings[a.BindingID]
					_, r := x.rootBindings[a.BindingID]
					if !b && !r {
						return fmt.Errorf("emission: unknown binding %q", a.BindingID)
					}
					if b && x.bindings[a.BindingID].kind == "export" {
						return fmt.Errorf("export binding %q emits edges", a.BindingID)
					}
				}
			}
		}
	}
	return nil
}

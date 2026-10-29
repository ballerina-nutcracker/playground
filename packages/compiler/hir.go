// HIR wire schema. Keep in sync with packages/workspace/src/flow.ts and docs/hir-wire.md.
package compiler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// HIRList preserves [] for empty collections, including a Go nil slice.
type HIRList[T any] []T

func (v HIRList[T]) MarshalJSON() ([]byte, error) {
	if v == nil {
		return []byte("[]"), nil
	}
	return json.Marshal([]T(v))
}
func (v *HIRList[T]) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fmt.Errorf("HIR array must not be null")
	}
	var items []T
	if err := hirDecode(data, &items); err != nil {
		return err
	}
	*v = items
	return nil
}

// HIRRecord contains only typed values; nil records encode as {}.
type HIRRecord[T any] map[string]T

func (v HIRRecord[T]) MarshalJSON() ([]byte, error) {
	if v == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(map[string]T(v))
}
func (v *HIRRecord[T]) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fmt.Errorf("HIR record must not be null")
	}
	var items map[string]T
	if err := hirDecode(data, &items); err != nil {
		return err
	}
	*v = items
	return nil
}

// Only the codec uses raw JSON fields; graph data never contains untyped maps.
func hirTagged(kind string, value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	tag, err := json.Marshal(kind)
	if err != nil {
		return nil, err
	}
	result := append([]byte(`{"kind":`), tag...)
	if len(payload) > 2 {
		result = append(result, ',')
		result = append(result, payload[1:len(payload)-1]...)
	}
	return append(result, '}'), nil
}
func hirVariant(data []byte) (string, []byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return "", nil, err
	}
	var kind string
	if err := json.Unmarshal(fields["kind"], &kind); err != nil {
		return "", nil, fmt.Errorf("HIR variant requires kind: %w", err)
	}
	delete(fields, "kind")
	payload, err := json.Marshal(fields)
	return kind, payload, err
}
func hirDecode(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return fmt.Errorf("trailing HIR variant data")
	}
	return nil
}

type HIRProgram struct {
	FunctionViews HIRRecord[HIRGraph]     `json:"functionViews,omitempty"`
	Scopes        HIRList[ScopeModel]     `json:"scopes"`
	Sources       HIRRecord[LocatedModel] `json:"sources"`
	Functions     HIRRecord[HIRGraph]     `json:"functions"`
}

// UnmarshalJSON rejects missing required fields (including nullable keys), unknown
// fields, and null primitive/object values rather than accepting Go zero defaults.
func (p *HIRProgram) UnmarshalJSON(data []byte) error {
	type wire HIRProgram
	var value wire
	if err := hirDecode(data, &value); err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var actual, expected any
	if err := hirJSONScalars(data, &actual); err != nil {
		return err
	}
	if err := hirJSONScalars(encoded, &expected); err != nil {
		return err
	}
	if err := hirRequiredShape(actual, expected, "$"); err != nil {
		return err
	}
	*p = HIRProgram(value)
	return nil
}

// Raw objects are confined to the wire codec, never stored in the graph.
func hirRequiredShape(actual, expected any, path string) error {
	switch want := expected.(type) {
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: expected object", path)
		}
		for _, key := range []string{"functionViews", "calls"} {
			if value, exists := got[key]; exists && value == nil {
				return fmt.Errorf("%s.%s: optional field cannot be null", path, key)
			}
		}
		for key, child := range want {
			value, ok := got[key]
			if !ok {
				// Variable metadata is additive: archived HIR predating it
				// decodes as empty arrays. All older fields remain required.
				if key == "variables" || key == "signatureVariables" {
					continue
				}
				return fmt.Errorf("%s.%s: missing required field", path, key)
			}
			if err := hirRequiredShape(value, child, path+"."+key); err != nil {
				return err
			}
		}
	case []any:
		got, ok := actual.([]any)
		if !ok || len(got) != len(want) {
			return fmt.Errorf("%s: expected array", path)
		}
		for i := range want {
			if err := hirRequiredShape(got[i], want[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case HIRText:
		if got, ok := actual.(HIRText); !ok || got != want {
			return fmt.Errorf("%s: string is not losslessly representable", path)
		}
	case nil:
		if actual != nil {
			return fmt.Errorf("%s: expected null", path)
		}
	default:
		if actual == nil {
			return fmt.Errorf("%s: unexpected null", path)
		}
	}
	return nil
}

type HIRGraph struct {
	LocatedModel
	ModuleID   string                `json:"moduleId"`
	Entry      HIREntry              `json:"entry"`
	Nodes      HIRList[HIRNode]      `json:"nodes"`
	Ports      HIRList[HIRPort]      `json:"ports"`
	Edges      HIRList[HIREdge]      `json:"edges"`
	Groups     HIRList[HIRGroup]     `json:"groups"`
	RootGroup  string                `json:"rootGroup"`
	Interfaces HIRList[HIRInterface] `json:"interfaces"`
	Emission   HIREmissionModes      `json:"emission"`
}

type HIREmissionModes struct {
	Root   HIREmissionPlan `json:"root"`
	Inline HIREmissionPlan `json:"inline"`
}

type HIREntryKind string

const (
	HIREntryKindResource HIREntryKind = "resource"
	HIREntryKindRemote   HIREntryKind = "remote"
	HIREntryKindFunction HIREntryKind = "function"
	HIREntryKindMethod   HIREntryKind = "method"
)

// HIRVariableOccurrence identifies a resolved variable in its corresponding display text.
// Start and End are UTF-16 code-unit offsets, with an exclusive End.
type HIRVariableOccurrence struct {
	VariableID string `json:"variableId"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
}

type HIREntry struct {
	SignatureVariables HIRList[HIRVariableOccurrence] `json:"signatureVariables,omitempty"`
	Kind               HIREntryKind                   `json:"kind"`
	Owner              *string                        `json:"owner"`
	Operation          *string                        `json:"operation"`
	Name               string                         `json:"name"`
	Signature          string                         `json:"signature"`
	Parameters         HIRList[HIREntryParameter]     `json:"parameters"`
	ReturnType         string                         `json:"returnType"`
}

type HIRParameterLabel string

const (
	HIRParameterLabelPath  HIRParameterLabel = "Path"
	HIRParameterLabelInput HIRParameterLabel = "Input"
)

type HIREntryParameter struct {
	Variables HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Label     HIRParameterLabel              `json:"label"`
	Text      string                         `json:"text"`
}

type HIRCallSpan struct {
	Start       int     `json:"start"`
	End         int     `json:"end"`
	TargetID    *string `json:"targetId"`
	Unavailable *string `json:"unavailable"`
}

type HIRNode struct {
	Calls         HIRList[HIRCallSpan] `json:"calls,omitempty"`
	ID            string               `json:"id"`
	OccurrenceKey string               `json:"occurrenceKey"`
	SourceID      string               `json:"sourceId"`
	Presentation  HIRPresentation      `json:"presentation"`
	Body          HIRNodeBody          `json:"body"`
}

// HIRNodeBody holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRNodeBody struct{ Value HIRNodeBodyValue }
type HIRNodeBodyValue interface {
	isHIRNodeBody()
	json.Marshaler
}

type HIRLeafBody struct {
}

func (HIRLeafBody) isHIRNodeBody() {}
func (v HIRLeafBody) MarshalJSON() ([]byte, error) {
	type payload HIRLeafBody
	return hirTagged("leaf", payload(v))
}

type HIRGroupBody struct {
	GroupID string `json:"groupId"`
}

func (HIRGroupBody) isHIRNodeBody() {}
func (v HIRGroupBody) MarshalJSON() ([]byte, error) {
	type payload HIRGroupBody
	return hirTagged("group", payload(v))
}

type HIRReferenceBody struct {
	Reference HIRGraphReference `json:"reference"`
}

func (HIRReferenceBody) isHIRNodeBody() {}
func (v HIRReferenceBody) MarshalJSON() ([]byte, error) {
	type payload HIRReferenceBody
	return hirTagged("reference", payload(v))
}

func (v HIRNodeBody) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRNodeBody")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRNodeBody")
	}
	return data, err
}

func (v *HIRNodeBody) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRNodeBodyValue
	switch kind {
	case "leaf":
		value = new(HIRLeafBody)
	case "group":
		value = new(HIRGroupBody)
	case "reference":
		value = new(HIRReferenceBody)
	default:
		return fmt.Errorf("unknown HIRNodeBody kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIRNodeStyle string

const (
	HIRNodeStyleStep             HIRNodeStyle = "step"
	HIRNodeStyleCondition        HIRNodeStyle = "condition"
	HIRNodeStyleFunction         HIRNodeStyle = "function"
	HIRNodeStyleLoop             HIRNodeStyle = "loop"
	HIRNodeStyleMapping          HIRNodeStyle = "mapping"
	HIRNodeStyleUnsupported      HIRNodeStyle = "unsupported"
	HIRNodeStyleReturn           HIRNodeStyle = "return"
	HIRNodeStyleClient           HIRNodeStyle = "client"
	HIRNodeStyleTrap             HIRNodeStyle = "trap"
	HIRNodeStylePanic            HIRNodeStyle = "panic"
	HIRNodeStyleTemplate         HIRNodeStyle = "template"
	HIRNodeStyleErrorConstructor HIRNodeStyle = "error-constructor"
)

type HIRLabelSectionKind string

const (
	HIRLabelSectionKindText               HIRLabelSectionKind = "text"
	HIRLabelSectionKindReceiver           HIRLabelSectionKind = "receiver"
	HIRLabelSectionKindContext            HIRLabelSectionKind = "context"
	HIRLabelSectionKindMethod             HIRLabelSectionKind = "method"
	HIRLabelSectionKindErrorMessage       HIRLabelSectionKind = "error-message"
	HIRLabelSectionKindErrorCause         HIRLabelSectionKind = "error-cause"
	HIRLabelSectionKindErrorDetail        HIRLabelSectionKind = "error-detail"
	HIRLabelSectionKindTemplateType       HIRLabelSectionKind = "template-type"
	HIRLabelSectionKindTemplateExpression HIRLabelSectionKind = "template-expression"
)

type HIRLabelSection struct {
	Variables HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Kind      HIRLabelSectionKind            `json:"kind"`
	Text      HIRText                        `json:"text"`
}

type HIRClientStyle string

const (
	HIRClientStyleClient HIRClientStyle = "client"
)

// HIRPresentation holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRPresentation struct{ Value HIRPresentationValue }
type HIRPresentationValue interface {
	isHIRPresentation()
	json.Marshaler
}

type HIRHiddenPresentation struct {
}

func (HIRHiddenPresentation) isHIRPresentation() {}
func (v HIRHiddenPresentation) MarshalJSON() ([]byte, error) {
	type payload HIRHiddenPresentation
	return hirTagged("hidden", payload(v))
}

type HIRPlainPresentation struct {
	Variables  HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Style      HIRNodeStyle                   `json:"style"`
	Label      HIRText                        `json:"label"`
	Sections   HIRList[HIRLabelSection]       `json:"sections"`
	Limitation *string                        `json:"limitation"`
	Disclosure HIRDisclosure                  `json:"disclosure"`
}

func (HIRPlainPresentation) isHIRPresentation() {}
func (v HIRPlainPresentation) MarshalJSON() ([]byte, error) {
	type payload HIRPlainPresentation
	return hirTagged("plain", payload(v))
}

type HIRClientPresentation struct {
	Variables  HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Style      HIRClientStyle                 `json:"style"`
	Label      HIRText                        `json:"label"`
	Sections   HIRList[HIRLabelSection]       `json:"sections"`
	Limitation *string                        `json:"limitation"`
	Disclosure HIRDisclosure                  `json:"disclosure"`
}

func (HIRClientPresentation) isHIRPresentation() {}
func (v HIRClientPresentation) MarshalJSON() ([]byte, error) {
	type payload HIRClientPresentation
	return hirTagged("client", payload(v))
}

func (v HIRPresentation) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRPresentation")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRPresentation")
	}
	return data, err
}

func (v *HIRPresentation) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRPresentationValue
	switch kind {
	case "hidden":
		value = new(HIRHiddenPresentation)
	case "plain":
		value = new(HIRPlainPresentation)
	case "client":
		value = new(HIRClientPresentation)
	default:
		return fmt.Errorf("unknown HIRPresentation kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

// HIRDisclosure holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRDisclosure struct{ Value HIRDisclosureValue }
type HIRDisclosureValue interface {
	isHIRDisclosure()
	json.Marshaler
}

type HIRNoDisclosure struct {
}

func (HIRNoDisclosure) isHIRDisclosure() {}
func (v HIRNoDisclosure) MarshalJSON() ([]byte, error) {
	type payload HIRNoDisclosure
	return hirTagged("none", payload(v))
}

type HIRCallDisclosure struct {
	OccurrenceKey string                   `json:"occurrenceKey"`
	Availability  HIRAvailability          `json:"availability"`
	Recursive     HIRRecursivePresentation `json:"recursive"`
}

func (HIRCallDisclosure) isHIRDisclosure() {}
func (v HIRCallDisclosure) MarshalJSON() ([]byte, error) {
	type payload HIRCallDisclosure
	return hirTagged("call", payload(v))
}

// UnmarshalJSON keeps the nested client-context call field a strict call variant.
func (v *HIRCallDisclosure) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	if kind != "call" {
		return fmt.Errorf("expected call disclosure, got %q", kind)
	}
	type wire HIRCallDisclosure
	return hirDecode(payload, (*wire)(v))
}

type HIRClientContextDisclosure struct {
	Call              *HIRCallDisclosure        `json:"call"`
	ExpandedRecursive *HIRRecursivePresentation `json:"expandedRecursive"`
	OccurrenceKey     string                    `json:"occurrenceKey"`
	Collapsed         HIRLabelContent           `json:"collapsed"`
	Expanded          HIRLabelContent           `json:"expanded"`
}

func (HIRClientContextDisclosure) isHIRDisclosure() {}
func (v HIRClientContextDisclosure) MarshalJSON() ([]byte, error) {
	type payload HIRClientContextDisclosure
	return hirTagged("client-context", payload(v))
}

func (v HIRDisclosure) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRDisclosure")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRDisclosure")
	}
	return data, err
}

func (v *HIRDisclosure) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRDisclosureValue
	switch kind {
	case "none":
		value = new(HIRNoDisclosure)
	case "call":
		var call HIRCallDisclosure
		if err := json.Unmarshal(data, &call); err != nil {
			return err
		}
		v.Value = &call
		return nil
	case "client-context":
		value = new(HIRClientContextDisclosure)
	default:
		return fmt.Errorf("unknown HIRDisclosure kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIRLabelContent struct {
	Variables HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Label     HIRText                        `json:"label"`
	Sections  HIRList[HIRLabelSection]       `json:"sections"`
}

type HIRRecursivePresentation struct {
	Variables  HIRList[HIRVariableOccurrence] `json:"variables,omitempty"`
	Label      HIRText                        `json:"label"`
	Sections   HIRList[HIRLabelSection]       `json:"sections"`
	Limitation *string                        `json:"limitation"`
	Title      HIRText                        `json:"title"`
	AriaLabel  HIRText                        `json:"ariaLabel"`
	Glyph      string                         `json:"glyph"`
}

// HIRAvailability holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRAvailability struct{ Value HIRAvailabilityValue }
type HIRAvailabilityValue interface {
	isHIRAvailability()
	json.Marshaler
}

type HIRAvailable struct {
}

func (HIRAvailable) isHIRAvailability() {}
func (v HIRAvailable) MarshalJSON() ([]byte, error) {
	type payload HIRAvailable
	return hirTagged("available", payload(v))
}

type HIRUnavailable struct {
	Reason string `json:"reason"`
}

func (HIRUnavailable) isHIRAvailability() {}
func (v HIRUnavailable) MarshalJSON() ([]byte, error) {
	type payload HIRUnavailable
	return hirTagged("unavailable", payload(v))
}

func (v HIRAvailability) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRAvailability")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRAvailability")
	}
	return data, err
}

func (v *HIRAvailability) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRAvailabilityValue
	switch kind {
	case "available":
		value = new(HIRAvailable)
	case "unavailable":
		value = new(HIRUnavailable)
	default:
		return fmt.Errorf("unknown HIRAvailability kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIRPortRole string

const (
	HIRPortRoleEntry         HIRPortRole = "entry"
	HIRPortRoleNormalExit    HIRPortRole = "normal-exit"
	HIRPortRoleTrue          HIRPortRole = "true"
	HIRPortRoleFalse         HIRPortRole = "false"
	HIRPortRoleReturn        HIRPortRole = "return"
	HIRPortRoleBreak         HIRPortRole = "break"
	HIRPortRoleContinue      HIRPortRole = "continue"
	HIRPortRoleNextIteration HIRPortRole = "next-iteration"
	HIRPortRolePanic         HIRPortRole = "panic"
)

type HIRAnchorKind string

const (
	HIRAnchorKindTopCenter          HIRAnchorKind = "top-center"
	HIRAnchorKindHeaderLeft         HIRAnchorKind = "header-left"
	HIRAnchorKindHeaderRight        HIRAnchorKind = "header-right"
	HIRAnchorKindHeaderBottomCenter HIRAnchorKind = "header-bottom-center"
	HIRAnchorKindBottomCenter       HIRAnchorKind = "bottom-center"
	HIRAnchorKindGroupBottomCenter  HIRAnchorKind = "group-bottom-center"
	HIRAnchorKindIterationMarker    HIRAnchorKind = "iteration-marker"
)

type HIRAnchor struct {
	Kind HIRAnchorKind `json:"kind"`
}

type HIRPort struct {
	OccurrenceKey string      `json:"occurrenceKey"`
	ID            string      `json:"id"`
	NodeID        string      `json:"nodeId"`
	Role          HIRPortRole `json:"role"`
	Anchor        HIRAnchor   `json:"anchor"`
}

type HIREdgeKind string

const (
	HIREdgeKindSequence HIREdgeKind = "sequence"
	HIREdgeKindTrue     HIREdgeKind = "true"
	HIREdgeKindFalse    HIREdgeKind = "false"
	HIREdgeKindBack     HIREdgeKind = "back"
	HIREdgeKindBreak    HIREdgeKind = "break"
	HIREdgeKindContinue HIREdgeKind = "continue"
	HIREdgeKindReturn   HIREdgeKind = "return"
	HIREdgeKindError    HIREdgeKind = "error"
	HIREdgeKindPanic    HIREdgeKind = "panic"
)

type HIRRouting string

const (
	HIRRoutingDirect      HIRRouting = "direct"
	HIRRoutingBranchLeft  HIRRouting = "branch-left"
	HIRRoutingBranchRight HIRRouting = "branch-right"
	HIRRoutingBack        HIRRouting = "back"
)

type HIREdgeStyle struct {
	Kind    HIREdgeKind `json:"kind"`
	Label   *string     `json:"label"`
	Routing HIRRouting  `json:"routing"`
}

type HIREdge struct {
	HIREdgeStyle
	ID       string      `json:"id"`
	FromPort string      `json:"fromPort"`
	ToPort   string      `json:"toPort"`
	When     HIRPresence `json:"when"`
}

type HIRGroup struct {
	ID          string         `json:"id"`
	Arrangement HIRArrangement `json:"arrangement"`
	Style       HIRGroupStyle  `json:"style"`
}

// HIRArrangement holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRArrangement struct{ Value HIRArrangementValue }
type HIRArrangementValue interface {
	isHIRArrangement()
	json.Marshaler
}

type HIRSequenceArrangement struct {
	Members HIRList[string] `json:"members"`
}

func (HIRSequenceArrangement) isHIRArrangement() {}
func (v HIRSequenceArrangement) MarshalJSON() ([]byte, error) {
	type payload HIRSequenceArrangement
	return hirTagged("sequence", payload(v))
}

type HIRColumnsArrangement struct {
	Left  HIRList[string] `json:"left"`
	Right HIRList[string] `json:"right"`
}

func (HIRColumnsArrangement) isHIRArrangement() {}
func (v HIRColumnsArrangement) MarshalJSON() ([]byte, error) {
	type payload HIRColumnsArrangement
	return hirTagged("columns", payload(v))
}

type HIRContainerArrangement struct {
	Members HIRList[string] `json:"members"`
}

func (HIRContainerArrangement) isHIRArrangement() {}
func (v HIRContainerArrangement) MarshalJSON() ([]byte, error) {
	type payload HIRContainerArrangement
	return hirTagged("container", payload(v))
}

func (v HIRArrangement) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRArrangement")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRArrangement")
	}
	return data, err
}

func (v *HIRArrangement) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRArrangementValue
	switch kind {
	case "sequence":
		value = new(HIRSequenceArrangement)
	case "columns":
		value = new(HIRColumnsArrangement)
	case "container":
		value = new(HIRContainerArrangement)
	default:
		return fmt.Errorf("unknown HIRArrangement kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIRGroupVisibility struct {
	Node      bool `json:"node"`
	Header    bool `json:"header"`
	Container bool `json:"container"`
}

type HIRSpacingProfile string

const (
	HIRSpacingProfileSequence HIRSpacingProfile = "sequence"
	HIRSpacingProfileIf       HIRSpacingProfile = "if"
	HIRSpacingProfileWhile    HIRSpacingProfile = "while"
	HIRSpacingProfileForeach  HIRSpacingProfile = "foreach"
	HIRSpacingProfileTrap     HIRSpacingProfile = "trap"
	HIRSpacingProfileRoot     HIRSpacingProfile = "root"
	HIRSpacingProfileCall     HIRSpacingProfile = "call"
)

type HIRGroupStyle struct {
	Profile HIRSpacingProfile  `json:"profile"`
	Root    HIRGroupVisibility `json:"root"`
	Inline  HIRGroupVisibility `json:"inline"`
}

type HIRInterface struct {
	ID      string                      `json:"id"`
	Members HIRList[HIRInterfaceMember] `json:"members"`
	Exports HIRList[HIRInterfaceExport] `json:"exports"`
	Root    HIRRootTreatment            `json:"root"`
}

type HIRInterfaceMember struct {
	PortID string      `json:"portId"`
	When   HIRPresence `json:"when"`
}

type HIRInterfaceExport struct {
	BindingID    string `json:"bindingId"`
	BeforeMember int    `json:"beforeMember"`
}

// HIRRootTreatment holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRRootTreatment struct{ Value HIRRootTreatmentValue }
type HIRRootTreatmentValue interface {
	isHIRRootTreatment()
	json.Marshaler
}

type HIRTerminalRoot struct {
}

func (HIRTerminalRoot) isHIRRootTreatment() {}
func (v HIRTerminalRoot) MarshalJSON() ([]byte, error) {
	type payload HIRTerminalRoot
	return hirTagged("terminal", payload(v))
}

type HIRConnectRoot struct {
	BindingID string       `json:"bindingId"`
	ToPort    string       `json:"toPort"`
	Edge      HIREdgeStyle `json:"edge"`
}

func (HIRConnectRoot) isHIRRootTreatment() {}
func (v HIRConnectRoot) MarshalJSON() ([]byte, error) {
	type payload HIRConnectRoot
	return hirTagged("connect", payload(v))
}

func (v HIRRootTreatment) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRRootTreatment")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRRootTreatment")
	}
	return data, err
}

func (v *HIRRootTreatment) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRRootTreatmentValue
	switch kind {
	case "terminal":
		value = new(HIRTerminalRoot)
	case "connect":
		value = new(HIRConnectRoot)
	default:
		return fmt.Errorf("unknown HIRRootTreatment kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIRGraphReference struct {
	GraphID       string                `json:"graphId"`
	OccurrenceKey string                `json:"occurrenceKey"`
	Availability  HIRAvailability       `json:"availability"`
	Container     HIRGroupStyle         `json:"container"`
	Collapsed     HIRCollapsedReference `json:"collapsed"`
	Inline        HIRList[HIRBinding]   `json:"inline"`
}

type HIRCollapsedReference struct {
	Interfaces HIRList[HIRInterface] `json:"interfaces"`
	Edges      HIRList[HIREdge]      `json:"edges"`
}

// HIRBinding holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRBinding struct{ Value HIRBindingValue }
type HIRBindingValue interface {
	isHIRBinding()
	json.Marshaler
}

type HIREntryBinding struct {
	ID                string       `json:"id"`
	When              HIRPresence  `json:"when"`
	CallerPortID      string       `json:"callerPortId"`
	TargetInterfaceID string       `json:"targetInterfaceId"`
	Edge              HIREdgeStyle `json:"edge"`
}

func (HIREntryBinding) isHIRBinding() {}
func (v HIREntryBinding) MarshalJSON() ([]byte, error) {
	type payload HIREntryBinding
	return hirTagged("entry", payload(v))
}

type HIRExitBinding struct {
	ID                string       `json:"id"`
	When              HIRPresence  `json:"when"`
	CallerPortID      string       `json:"callerPortId"`
	TargetInterfaceID string       `json:"targetInterfaceId"`
	Edge              HIREdgeStyle `json:"edge"`
}

func (HIRExitBinding) isHIRBinding() {}
func (v HIRExitBinding) MarshalJSON() ([]byte, error) {
	type payload HIRExitBinding
	return hirTagged("exit", payload(v))
}

type HIRExportBinding struct {
	ID                string      `json:"id"`
	When              HIRPresence `json:"when"`
	TargetInterfaceID string      `json:"targetInterfaceId"`
	CallerInterfaceID string      `json:"callerInterfaceId"`
}

func (HIRExportBinding) isHIRBinding() {}
func (v HIRExportBinding) MarshalJSON() ([]byte, error) {
	type payload HIRExportBinding
	return hirTagged("export", payload(v))
}

func (v HIRBinding) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRBinding")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRBinding")
	}
	return data, err
}

func (v *HIRBinding) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRBindingValue
	switch kind {
	case "entry":
		value = new(HIREntryBinding)
	case "exit":
		value = new(HIRExitBinding)
	case "export":
		value = new(HIRExportBinding)
	default:
		return fmt.Errorf("unknown HIRBinding kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

// HIRPresence holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIRPresence struct{ Value HIRPresenceValue }
type HIRPresenceValue interface {
	isHIRPresence()
	json.Marshaler
}

type HIRConstantPresence struct {
	Value bool `json:"value"`
}

func (HIRConstantPresence) isHIRPresence() {}
func (v HIRConstantPresence) MarshalJSON() ([]byte, error) {
	type payload HIRConstantPresence
	return hirTagged("constant", payload(v))
}

type HIRAllPresence struct {
	Operands HIRList[HIRPresence] `json:"operands"`
}

func (HIRAllPresence) isHIRPresence() {}
func (v HIRAllPresence) MarshalJSON() ([]byte, error) {
	type payload HIRAllPresence
	return hirTagged("all", payload(v))
}

type HIRAnyPresence struct {
	Operands HIRList[HIRPresence] `json:"operands"`
}

func (HIRAnyPresence) isHIRPresence() {}
func (v HIRAnyPresence) MarshalJSON() ([]byte, error) {
	type payload HIRAnyPresence
	return hirTagged("any", payload(v))
}

type HIRNotPresence struct {
	Operand HIRPresence `json:"operand"`
}

func (HIRNotPresence) isHIRPresence() {}
func (v HIRNotPresence) MarshalJSON() ([]byte, error) {
	type payload HIRNotPresence
	return hirTagged("not", payload(v))
}

type HIRNonemptyPresence struct {
	ReferenceNodeID string `json:"referenceNodeId"`
	InterfaceID     string `json:"interfaceId"`
}

func (HIRNonemptyPresence) isHIRPresence() {}
func (v HIRNonemptyPresence) MarshalJSON() ([]byte, error) {
	type payload HIRNonemptyPresence
	return hirTagged("nonempty", payload(v))
}

func (v HIRPresence) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIRPresence")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIRPresence")
	}
	return data, err
}

func (v *HIRPresence) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIRPresenceValue
	switch kind {
	case "constant":
		value = new(HIRConstantPresence)
	case "all":
		value = new(HIRAllPresence)
	case "any":
		value = new(HIRAnyPresence)
	case "not":
		value = new(HIRNotPresence)
	case "nonempty":
		value = new(HIRNonemptyPresence)
	default:
		return fmt.Errorf("unknown HIRPresence kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

// HIREmission holds exactly one sealed, discriminated variant. Its zero value is invalid.
type HIREmission struct{ Value HIREmissionValue }
type HIREmissionValue interface {
	isHIREmission()
	json.Marshaler
}

type HIRLocalEmission struct {
	ItemID string      `json:"itemId"`
	When   HIRPresence `json:"when"`
}

func (HIRLocalEmission) isHIREmission() {}
func (v HIRLocalEmission) MarshalJSON() ([]byte, error) {
	type payload HIRLocalEmission
	return hirTagged("local", payload(v))
}

type HIRChildEmission struct {
	ReferenceNodeID string      `json:"referenceNodeId"`
	When            HIRPresence `json:"when"`
}

func (HIRChildEmission) isHIREmission() {}
func (v HIRChildEmission) MarshalJSON() ([]byte, error) {
	type payload HIRChildEmission
	return hirTagged("child", payload(v))
}

type HIRBindingEmission struct {
	BindingID string      `json:"bindingId"`
	When      HIRPresence `json:"when"`
}

func (HIRBindingEmission) isHIREmission() {}
func (v HIRBindingEmission) MarshalJSON() ([]byte, error) {
	type payload HIRBindingEmission
	return hirTagged("binding", payload(v))
}

func (v HIREmission) MarshalJSON() ([]byte, error) {
	if v.Value == nil {
		return nil, fmt.Errorf("nil HIREmission")
	}
	data, err := json.Marshal(v.Value)
	if err == nil && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("null HIREmission")
	}
	return data, err
}

func (v *HIREmission) UnmarshalJSON(data []byte) error {
	kind, payload, err := hirVariant(data)
	if err != nil {
		return err
	}
	var value HIREmissionValue
	switch kind {
	case "local":
		value = new(HIRLocalEmission)
	case "child":
		value = new(HIRChildEmission)
	case "binding":
		value = new(HIRBindingEmission)
	default:
		return fmt.Errorf("unknown HIREmission kind %q", kind)
	}
	if err := hirDecode(payload, value); err != nil {
		return err
	}
	v.Value = value
	return nil
}

type HIREmissionPlan struct {
	Nodes HIRList[HIREmission] `json:"nodes"`
	Ports HIRList[HIREmission] `json:"ports"`
	Edges HIRList[HIREmission] `json:"edges"`
}

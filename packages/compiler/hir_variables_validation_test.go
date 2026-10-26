package compiler

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestVariableSpanValidation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		spans HIRList[HIRVariableOccurrence]
		valid bool
	}{
		{"utf16", HIRList[HIRVariableOccurrence]{{"opaque", 2, 3}}, true},
		{"ordered adjacent", HIRList[HIRVariableOccurrence]{{"same", 0, 2}, {"same", 2, 3}}, true},
		{"unordered adjacent", HIRList[HIRVariableOccurrence]{{"same", 2, 3}, {"same", 0, 2}}, false},
		{"unordered nonoverlap", HIRList[HIRVariableOccurrence]{{"b", 2, 3}, {"a", 0, 1}}, false},
		{"empty identity", HIRList[HIRVariableOccurrence]{{"", 0, 1}}, false},
		{"whitespace identity", HIRList[HIRVariableOccurrence]{{" ", 0, 1}}, false},
		{"negative", HIRList[HIRVariableOccurrence]{{"id", -1, 1}}, false},
		{"empty", HIRList[HIRVariableOccurrence]{{"id", 1, 1}}, false},
		{"reversed", HIRList[HIRVariableOccurrence]{{"id", 2, 1}}, false},
		{"past utf16 end", HIRList[HIRVariableOccurrence]{{"id", 2, 4}}, false},
		{"overlap", HIRList[HIRVariableOccurrence]{{"a", 0, 2}, {"b", 1, 3}}, false},
		{"duplicate", HIRList[HIRVariableOccurrence]{{"a", 0, 1}, {"a", 0, 1}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := append(HIRList[HIRVariableOccurrence](nil), tc.spans...)
			err := hirCheckVariableSpans("🚀x", tc.spans)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t: %v", tc.valid, err)
			}
			if !reflect.DeepEqual(before, tc.spans) {
				t.Fatal("validator mutated spans")
			}
		})
	}
}

func TestVariableSpanValidationDisplayVariants(t *testing.T) {
	bad := HIRList[HIRVariableOccurrence]{{"id", 0, 2}}
	for _, value := range []any{
		HIREntry{Signature: "x", SignatureVariables: bad},
		HIREntryParameter{Text: "x", Variables: bad},
		HIRLabelSection{Text: "x", Variables: bad},
		HIRPlainPresentation{Label: "x", Variables: bad},
		HIRClientPresentation{Label: "x", Variables: bad},
		HIRLabelContent{Label: "x", Variables: bad},
		HIRRecursivePresentation{Label: "x", Variables: bad},
		HIRDisclosure{Value: &HIRCallDisclosure{Recursive: HIRRecursivePresentation{Label: "x", Variables: bad}}},
		HIRDisclosure{Value: &HIRClientContextDisclosure{Collapsed: HIRLabelContent{Label: "x", Variables: bad}}},
		HIRDisclosure{Value: &HIRClientContextDisclosure{Expanded: HIRLabelContent{Label: "x", Variables: bad}}},
		HIRDisclosure{Value: &HIRClientContextDisclosure{ExpandedRecursive: &HIRRecursivePresentation{Label: "x", Variables: bad}}},
	} {
		if err := hirVariableSpans(reflect.ValueOf(value)); err == nil {
			t.Errorf("accepted invalid spans in %T", value)
		}
	}
}

func TestVariableMetadataLegacyDecode(t *testing.T) {
	data, err := os.ReadFile("testdata/upstream/tests/fixtures/hir-contract/minimal.json")
	if err != nil {
		t.Fatal(err)
	}
	var p HIRProgram
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	if err := ValidateHIR(p); err != nil {
		t.Fatal(err)
	}
	for id, g := range p.Functions {
		g.Entry.SignatureVariables = HIRList[HIRVariableOccurrence]{{"id", 0, utf16Length(g.Entry.Signature) + 1}}
		p.Functions[id] = g
		if err := ValidateHIR(p); err == nil {
			t.Fatal("ValidateHIR accepted invalid occurrence bounds")
		}
		g.Entry.SignatureVariables = nil
		p.Functions[id] = g
		break
	}
	canonical, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(canonical, &raw); err != nil {
		t.Fatal(err)
	}
	graph := func(m map[string]any) map[string]any {
		for _, g := range m["functions"].(map[string]any) {
			return g.(map[string]any)
		}
		t.Fatal("missing graph")
		return nil
	}
	entry := graph(raw)["entry"].(map[string]any)
	// New arrays may be absent, but explicit null is still invalid.
	entry["signatureVariables"] = nil
	malformed, _ := json.Marshal(raw)
	if err := json.Unmarshal(malformed, &p); err == nil {
		t.Fatal("accepted null metadata")
	}
	delete(entry, "signatureVariables")
	delete(entry, "signature")
	malformed, _ = json.Marshal(raw)
	if err := json.Unmarshal(malformed, &p); err == nil {
		t.Fatal("accepted missing legacy required field")
	}
}

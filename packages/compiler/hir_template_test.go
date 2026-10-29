package compiler

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestTemplatePresentation(t *testing.T) {
	for _, tc := range []struct{ kind, expression string }{
		{"string", "`Hello ${name}`"},
		{"xml", "`<greeting>${name}</greeting>`"},
		{"string", "``"},
		{"xml", "``"},
		{"xml", "`<root/>`"},
		{"xml", "`text`"},
		{"xml", "`<!-- comment -->`"},
		{"xml", "`<?target data?>`"},
		{"xml", "`<root/> <other/>`"},
		{"xml", "`<root attribute=\"${name}\">\n<!-- comment -->${name}<child/></root>`"},
		{"xml", "`<root attribute=\"café\"/>`"},
		{"string", "`outer ${string `inner ${name}`}`"},
		{"xml", "`<outer>${xml `<inner>${name}</inner>`}</outer>`"},
	} {
		t.Run(tc.kind+tc.expression, func(t *testing.T) {
			source := tc.kind + " " + tc.expression
			result, err := Analyze(project("public function main() { string name = \"World\"; " + tc.kind + " value = " + source + "; _ = value; _ = name; }"))
			if err != nil || result.Kind != "valid" {
				t.Fatalf("analyze: %v %+v", err, result.Diagnostics)
			}
			found := false
			for _, g := range result.Program.Functions {
				for _, node := range g.Nodes {
					p, ok := node.Presentation.Value.(HIRPlainPresentation)
					if !ok || p.Style != HIRNodeStyleTemplate {
						continue
					}
					if p.Limitation != nil {
						t.Fatalf("template limitation: %s", *p.Limitation)
					}
					if string(p.Label) != source {
						continue
					}
					found = true
					want := HIRList[HIRLabelSection]{{Kind: HIRLabelSectionKindTemplateType, Text: HIRText(tc.kind)}, {Kind: HIRLabelSectionKindTemplateExpression, Text: HIRText(tc.expression)}}
					if !reflect.DeepEqual(p.Sections, want) {
						t.Fatalf("sections: %+v, want %+v", p.Sections, want)
					}
					if result.Program.Sources[node.SourceID].Text != source {
						t.Fatal("selection lost original complete source")
					}
				}
			}
			if !found {
				t.Fatalf("missing template %s", source)
			}
			if err := ValidateHIR(*result.Program); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(result.Program)
			if err != nil {
				t.Fatal(err)
			}
			var decoded HIRProgram
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatal(err)
			}
			if err := ValidateHIR(decoded); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestXMLTemplateEvaluationOrderAndIdentities(t *testing.T) {
	files := project("function first() returns string|error => \"one\";\nfunction second() returns string => \"two\";\npublic function main() returns error? {\n string name = \"World\";\n xml value = xml `<root>${name}${check first()}${second()}${name}</root>`;\n _ = value;\n}")
	p, diagnostics, err := resolveProgram(files)
	if err != nil || p == nil {
		t.Fatalf("resolve: %v %+v", err, diagnostics)
	}
	var previous string
	for repeat := 0; repeat < 3; repeat++ {
		hir, err := lowerProgram(p)
		if err != nil {
			t.Fatal(err)
		}
		printed := checkLoweredHIR(t, files, hir)
		if repeat > 0 && printed != previous {
			t.Fatal("nondeterministic XML lowering")
		}
		previous = printed
		for i, text := range []string{"name", "check first()", "second()", "name"} {
			found := false
			for id, loc := range hir.Sources {
				if !strings.HasSuffix(id, fmt.Sprintf("/statement/1/value/insertion/%d", i)) {
					continue
				}
				found = true
				if loc.Text != text {
					t.Fatalf("insertion %d: %q", i, loc.Text)
				}
				if i == 0 || i == 3 {
					for _, g := range hir.Functions {
						for _, n := range g.Nodes {
							if n.SourceID == id {
								t.Fatal("plain insertion emitted evaluation node")
							}
						}
					}
				}
			}
			if !found {
				t.Fatalf("missing insertion %d", i)
			}
		}
		for _, g := range hir.Functions {
			if g.Entry.Name != "main" {
				continue
			}
			// Prove the execution edges, not merely the order of labels in the array.
			byLabel := map[string]HIRNode{}
			owner := map[string]string{}
			for _, n := range g.Nodes {
				if presentation, ok := n.Presentation.Value.(HIRPlainPresentation); ok {
					byLabel[string(presentation.Label)] = n
				}
			}
			for _, port := range g.Ports {
				owner[port.ID] = port.NodeID
			}
			labels := []string{"first()", "check", "second()", "xml `<root>${name}${check first()}${second()}${name}</root>`"}
			for i := 1; i < len(labels); i++ {
				from, a := byLabel[labels[i-1]]
				to, b := byLabel[labels[i]]
				if !a || !b {
					t.Fatalf("missing evaluation nodes: %v", labels)
				}
				connected := false
				for _, edge := range g.Edges {
					if edge.Kind == HIREdgeKindSequence && owner[edge.FromPort] == from.ID && owner[edge.ToPort] == to.ID {
						connected = true
					}
				}
				if !connected {
					t.Fatalf("missing execution edge %s -> %s", labels[i-1], labels[i])
				}
			}
			for _, name := range []string{"first()", "second()"} {
				ref, ok := byLabel[name].Body.Value.(HIRReferenceBody)
				if !ok {
					t.Fatalf("%s missing expansion", name)
				}
				if _, available := ref.Reference.Availability.Value.(HIRAvailable); !available {
					t.Fatalf("%s not expandable", name)
				}
			}
		}
	}
}

func TestTemplateSectionValidation(t *testing.T) {
	valid := HIRList[HIRLabelSection]{{Kind: HIRLabelSectionKindTemplateType, Text: "xml"}, {Kind: HIRLabelSectionKindTemplateExpression, Text: "`<root/>`"}}
	for _, tc := range []struct {
		name     string
		style    HIRNodeStyle
		sections HIRList[HIRLabelSection]
		valid    bool
	}{
		{"valid", HIRNodeStyleTemplate, valid, true},
		{"legacy", HIRNodeStyleTemplate, HIRList[HIRLabelSection]{}, true},
		{"wrong style", HIRNodeStyleStep, valid, false},
		{"missing expression", HIRNodeStyleTemplate, valid[:1], false},
		{"wrong order", HIRNodeStyleTemplate, HIRList[HIRLabelSection]{valid[1], valid[0]}, false},
		{"unknown type", HIRNodeStyleTemplate, HIRList[HIRLabelSection]{{Kind: HIRLabelSectionKindTemplateType, Text: "raw"}, valid[1]}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateTemplateSections(tc.style, tc.sections); (err == nil) != tc.valid {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}

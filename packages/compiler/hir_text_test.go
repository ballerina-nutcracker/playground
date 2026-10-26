package compiler

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestHIRTextUTF16RoundTrip(t *testing.T) {
	for _, tc := range []struct {
		wire  string
		units []uint16
	}{
		{`"ascii <>&\n\t\"\\/"`, []uint16{'a', 's', 'c', 'i', 'i', ' ', '<', '>', '&', '\n', '\t', '"', '\\', '/'}},
		{`"😀"`, []uint16{0xd83d, 0xde00}},
		{`"\ud83d\ude00"`, []uint16{0xd83d, 0xde00}},
		{`"\ud83d…"`, []uint16{0xd83d, 0x2026}},
		{`"\ude00"`, []uint16{0xde00}},
		{`"\ud800x\udfff\ud800"`, []uint16{0xd800, 'x', 0xdfff, 0xd800}},
		{`"�"`, []uint16{0xfffd}},
	} {
		t.Run(tc.wire, func(t *testing.T) {
			want := hirTextFromUTF16(tc.units)
			var got HIRText
			if err := json.Unmarshal([]byte(tc.wire), &got); err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("decode bytes %x, want %x", got, want)
			}
			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			if !json.Valid(wire) {
				t.Fatalf("invalid JSON: %s", wire)
			}
			var round HIRText
			if err := json.Unmarshal(wire, &round); err != nil {
				t.Fatal(err)
			}
			if round != want {
				t.Fatalf("round trip bytes %x, want %x", round, want)
			}
		})
	}
}

func TestHIRTextRejectsMalformedInput(t *testing.T) {
	for _, wire := range [][]byte{[]byte(`null`), []byte(`42`), []byte(`"\u123"`), []byte(`"\x00"`), {'"', 0xff, '"'}, {'"', 0xed, 0xa0, 0x80, '"'}} {
		var text HIRText
		if err := json.Unmarshal(wire, &text); err == nil {
			t.Errorf("accepted %q", wire)
		}
	}
	if _, err := json.Marshal(HIRText("\xff")); err == nil {
		t.Fatal("accepted malformed internal bytes")
	}
}

func TestHIRTextEncoderEscaping(t *testing.T) {
	text := HIRText("<>&😀\u2028")
	want, _ := json.Marshal(string(text))
	got, err := json.Marshal(text)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("default encoding %s != %s (%v)", got, want, err)
	}
	var a, b bytes.Buffer
	ea, eb := json.NewEncoder(&a), json.NewEncoder(&b)
	ea.SetEscapeHTML(false)
	eb.SetEscapeHTML(false)
	_ = ea.Encode(text)
	_ = eb.Encode(string(text))
	if a.String() != b.String() {
		t.Fatalf("unescaped encoding %s != %s", &a, &b)
	}
}

func TestHIRTextProgramRoundTrip(t *testing.T) {
	data, err := os.ReadFile("testdata/upstream/tests/fixtures/hir-contract/minimal.json")
	if err != nil {
		t.Fatal(err)
	}
	var program HIRProgram
	if err := json.Unmarshal(data, &program); err != nil {
		t.Fatal(err)
	}
	text := HIRText("<heading>😀") + hirTextFromUTF16([]uint16{0xd800, 'x', 0xdc00})
	content := HIRLabelContent{Label: text, Sections: HIRList[HIRLabelSection]{{Kind: HIRLabelSectionKindText, Text: text}}}
	graph := program.Functions["main"]
	graph.Nodes[0].Presentation = HIRPresentation{Value: HIRClientPresentation{
		Style: HIRClientStyleClient, Label: text, Sections: content.Sections,
		Disclosure: HIRDisclosure{Value: HIRClientContextDisclosure{OccurrenceKey: "a/context", Collapsed: content, Expanded: content}},
	}}
	program.Functions["main"] = graph
	if err := ValidateHIR(program); err != nil {
		t.Fatal(err)
	}
	printed, err := PrintHIR(program)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(printed, `\ud800x\udc00`) {
		t.Fatalf("lost isolated units: %s", printed)
	}
	var round HIRProgram
	if err := json.Unmarshal([]byte(printed), &round); err != nil {
		t.Fatal(err)
	}
	presentation := round.Functions["main"].Nodes[0].Presentation.Value.(*HIRClientPresentation)
	if presentation.Label != text || presentation.Sections[0].Text != text {
		t.Fatal("presentation lost UTF-16 units")
	}
	disclosure := presentation.Disclosure.Value.(*HIRClientContextDisclosure)
	if disclosure.Collapsed.Label != text || disclosure.Expanded.Sections[0].Text != text {
		t.Fatal("disclosure lost UTF-16 units")
	}
	if round.Sources["main"].Text != "😀" {
		t.Fatal("source text changed")
	}
	printedAgain, err := PrintHIR(round)
	if err != nil || printedAgain != printed {
		t.Fatalf("unstable PrintHIR round trip: %v", err)
	}

	recursive := HIRRecursivePresentation{Label: text, Title: text, AriaLabel: text, Sections: content.Sections}
	encoded, err := json.Marshal(recursive)
	if err != nil {
		t.Fatal(err)
	}
	var recursiveRound HIRRecursivePresentation
	if err := json.Unmarshal(encoded, &recursiveRound); err != nil {
		t.Fatal(err)
	}
	if recursiveRound.Label != text || recursiveRound.Title != text || recursiveRound.AriaLabel != text || recursiveRound.Sections[0].Text != text {
		t.Fatal("recursive presentation lost UTF-16 units")
	}
}

func TestClientContextSummaryUTF16(t *testing.T) {
	for _, tc := range []struct {
		text      string
		want      HIRText
		truncated bool
	}{
		{strings.Repeat("x", 90), HIRText(strings.Repeat("x", 90)), false},
		{strings.Repeat("x", 91), HIRText(strings.Repeat("x", 87) + "…"), true},
		{strings.Repeat("x", 86) + "😀tail", HIRText(strings.Repeat("x", 86)) + hirTextFromUTF16([]uint16{0xd83d}) + "…", true},
		{strings.Repeat("x", 85) + "😀tail", HIRText(strings.Repeat("x", 85) + "😀…"), true},
	} {
		got, truncated := clientContextSummary(tc.text)
		if HIRText(got) != tc.want || truncated != tc.truncated {
			t.Fatalf("summary bytes %x / %t, want %x / %t", got, truncated, tc.want, tc.truncated)
		}
	}
}

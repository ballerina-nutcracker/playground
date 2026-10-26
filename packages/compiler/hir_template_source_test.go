package compiler

import (
	"strings"
	"testing"
)

func TestXMLTemplateAttributeSourceRanges(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		source := "public function main() {" + newline +
			" xml first = xml `<a p=\"café\"/>`;" + newline +
			" xml second = xml `<b p=\"value\" q=\"two\"/>`;" + newline +
			" _ = first; _ = second;" + newline + "}" + newline +
			"# Documented after quoted XML." + newline +
			"public function after() { int value = 1; _ = value; }" + newline
		result, err := Analyze(project(source))
		if err != nil || result.Kind != "valid" {
			t.Fatalf("analyze: %v %+v", err, result.Diagnostics)
		}
		for _, fn := range result.Program.Functions {
			if fn.Entry.Name == "after" {
				if fn.Text != "public function after() { int value = 1; _ = value; }" {
					t.Fatalf("documented function source: %q", fn.Text)
				}
				if fn.Entry.Signature != "public function after()" {
					t.Fatalf("signature: %q", fn.Entry.Signature)
				}
			}
		}
		for _, loc := range result.Program.Sources {
			switch {
			case strings.HasSuffix(loc.ID, "/statement/2"):
				if loc.Text != "_ = first;" {
					t.Fatalf("statement after attributes: %q", loc.Text)
				}
			case strings.HasSuffix(loc.ID, "/statement/3"):
				if loc.Text != "_ = second;" {
					t.Fatalf("statement after attributes: %q", loc.Text)
				}
			}
		}
	}
}

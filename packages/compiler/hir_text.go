package compiler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// HIRText is derived presentation text, not source text or an identifier.
// It uses UTF-8 for Unicode scalars and WTF-8 for isolated UTF-16 surrogates,
// so JavaScript slice results survive ordinary JSON string transport unchanged.
// Do not range over it to recover UTF-16 units: Go replaces surrogate encodings.
type HIRText string

// hirJSONScalars inspects wire strings without encoding/json's replacement of
// malformed Unicode. Presentation values retain UTF-16 units; object keys must
// always be Unicode scalars. Comparing these values with the typed re-encoding
// detects any lossy decoding of ordinary source/identity strings.
func hirJSONScalars(data []byte, value *any) error {
	if !json.Valid(data) || !utf8.Valid(data) {
		return fmt.Errorf("invalid HIR JSON or UTF-8")
	}
	for i := 0; i < len(data); i++ {
		if data[i] != '"' {
			continue
		}
		start := i
		for i++; i < len(data); i++ {
			if data[i] == '\\' {
				i++
				continue
			}
			if data[i] == '"' {
				break
			}
		}
		end := i + 1
		j := end
		for j < len(data) && (data[j] == ' ' || data[j] == '\n' || data[j] == '\r' || data[j] == '\t') {
			j++
		}
		if j < len(data) && data[j] == ':' {
			var key HIRText
			if err := json.Unmarshal(data[start:end], &key); err != nil {
				return err
			}
			if !utf8.ValidString(string(key)) {
				return fmt.Errorf("invalid Unicode in HIR object key")
			}
		}
	}
	return hirJSONScalarValue(data, value)
}

func hirJSONScalarValue(data []byte, value *any) error {
	data = bytes.TrimSpace(data)
	switch data[0] {
	case '"':
		var text HIRText
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		*value = text
	case '{':
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return err
		}
		items := make(map[string]any, len(raw))
		for key, child := range raw {
			var item any
			if err := hirJSONScalarValue(child, &item); err != nil {
				return err
			}
			items[key] = item
		}
		*value = items
	case '[':
		var raw []json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return err
		}
		items := make([]any, len(raw))
		for i, child := range raw {
			if err := hirJSONScalarValue(child, &items[i]); err != nil {
				return err
			}
		}
		*value = items
	default:
		return json.Unmarshal(data, value)
	}
	return nil
}

// hirTextFromUTF16 combines valid pairs but retains isolated code units.
func hirTextFromUTF16(units []uint16) HIRText {
	out := make([]byte, 0, len(units))
	for i := 0; i < len(units); i++ {
		u := units[i]
		if u >= 0xd800 && u <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
			out = utf8.AppendRune(out, utf16.DecodeRune(rune(u), rune(units[i+1])))
			i++
		} else if u >= 0xd800 && u <= 0xdfff {
			out = append(out, byte(0xe0|u>>12), byte(0x80|(u>>6)&0x3f), byte(0x80|u&0x3f))
		} else {
			out = utf8.AppendRune(out, rune(u))
		}
	}
	return HIRText(out)
}

// Leave HTML escaping to the containing encoder, including PrintHIR's opt-out.
func hirTextJSONChunk(s string) []byte {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(s)
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'})
}

func (text HIRText) MarshalJSON() ([]byte, error) {
	s := string(text)
	out := []byte{'"'}
	start := 0
	for i := 0; i < len(s); {
		if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2] >= 0x80 && s[i+2] <= 0xbf {
			chunk := hirTextJSONChunk(s[start:i])
			out = append(out, chunk[1:len(chunk)-1]...)
			u := uint16(s[i]&0x0f)<<12 | uint16(s[i+1]&0x3f)<<6 | uint16(s[i+2]&0x3f)
			const hex = "0123456789abcdef"
			out = append(out, '\\', 'u', hex[u>>12], hex[u>>8&15], hex[u>>4&15], hex[u&15])
			i += 3
			start = i
			continue
		}
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n == 1 {
			return nil, fmt.Errorf("invalid UTF-8 in HIRText at byte %d", i)
		}
		i += n
	}
	chunk := hirTextJSONChunk(s[start:])
	out = append(out, chunk[1:len(chunk)-1]...)
	return append(out, '"'), nil
}

func (text *HIRText) UnmarshalJSON(data []byte) error {
	// json.Valid checks escape spelling/control characters; UTF-8 is checked below
	// because encoding/json otherwise silently replaces malformed bytes.
	if !json.Valid(data) {
		return fmt.Errorf("invalid HIRText JSON")
	}
	// UnmarshalJSON may also be invoked directly with surrounding whitespace.
	for len(data) > 0 && (data[0] == ' ' || data[0] == '\n' || data[0] == '\r' || data[0] == '\t') {
		data = data[1:]
	}
	for len(data) > 0 && (data[len(data)-1] == ' ' || data[len(data)-1] == '\n' || data[len(data)-1] == '\r' || data[len(data)-1] == '\t') {
		data = data[:len(data)-1]
	}
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return fmt.Errorf("HIRText must be a JSON string")
	}
	units := make([]uint16, 0, len(data)-2)
	for i := 1; i < len(data)-1; {
		if data[i] == '\\' {
			i++
			if data[i] == 'u' {
				u, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
				if err != nil {
					return err
				}
				units = append(units, uint16(u))
				i += 5
			} else {
				var u uint16
				switch data[i] {
				case '"':
					u = '"'
				case '\\':
					u = '\\'
				case '/':
					u = '/'
				case 'b':
					u = '\b'
				case 'f':
					u = '\f'
				case 'n':
					u = '\n'
				case 'r':
					u = '\r'
				case 't':
					u = '\t'
				}
				units = append(units, u)
				i++
			}
			continue
		}
		r, n := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && n == 1 {
			return fmt.Errorf("invalid UTF-8 in HIRText JSON at byte %d", i)
		}
		if r > 0xffff {
			hi, lo := utf16.EncodeRune(r)
			units = append(units, uint16(hi), uint16(lo))
		} else {
			units = append(units, uint16(r))
		}
		i += n
	}
	*text = hirTextFromUTF16(units)
	return nil
}

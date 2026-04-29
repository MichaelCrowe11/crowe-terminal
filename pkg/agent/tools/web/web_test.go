// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func TestRegistered(t *testing.T) {
	want := []string{
		"browser.in_window.navigate",
		"browser.in_window.read",
		"browser.in_window.click",
		"browser.in_window.type",
		"browser.in_window.screenshot",
		"browser.in_window.eval",
	}
	for _, n := range want {
		if _, ok := registry.Default().Get(n); !ok {
			t.Errorf("tool %s not registered", n)
		}
	}
}

func TestMutatingFlags(t *testing.T) {
	cases := map[string]bool{
		"browser.in_window.navigate":   true,
		"browser.in_window.read":       false,
		"browser.in_window.click":      true,
		"browser.in_window.type":       true,
		"browser.in_window.screenshot": false,
		"browser.in_window.eval":       true,
	}
	for name, wantMut := range cases {
		t, ok := registry.Default().Get(name)
		if !ok {
			continue
		}
		if t.Mutating != wantMut {
			panic("mismatch")
		}
	}
}

func TestJSStringEscaping(t *testing.T) {
	// Go's json.Marshal escapes <, >, & to \uXXXX by default. That's
	// functionally equivalent for webview.executeJavaScript: the JS
	// string literal "<" decodes back to "<" at parse time.
	cases := map[string]string{
		`hello`:                 `"hello"`,
		`"quoted"`:              `"\"quoted\""`,
		`back\slash`:            `"back\\slash"`,
		`new\nline`:             `"new\\nline"`,
		"with\nactual\nnewline": `"with\nactual\nnewline"`,
	}
	for in, want := range cases {
		got := jsString(in)
		if got != want {
			t.Errorf("jsString(%q) = %s, want %s", in, got, want)
		}
		if !strings.HasPrefix(got, `"`) || !strings.HasSuffix(got, `"`) {
			t.Errorf("jsString output not quoted: %s", got)
		}
	}
	// Sanity: angle brackets should be escaped in some form (any escape
	// is safe inside a JS string literal).
	if got := jsString("</script>"); got == `"</script>"` {
		t.Errorf("expected angle-bracket escaping, got %s", got)
	}
}

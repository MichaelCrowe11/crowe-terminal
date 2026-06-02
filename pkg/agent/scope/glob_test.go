// pkg/agent/scope/glob_test.go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"strings"
	"testing"
	"time"
)

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pat, tgt string
		want     bool
	}{
		{"src/*.ts", "src/index.ts", true},
		{"src/*.ts", "src/sub/index.ts", false},
		{"**/*.ts", "a.ts", true},
		{"**/*.ts", "src/deep/a.ts", true},
		{"src/**", "src", true},
		{"src/**", "src/deep/a.ts", true},
		{"src/**", "srcfoo/x", false},
		{"ws1/**", "ws10/secret", false},
		{"file?.ts", "file1.ts", true},
		{"file?.ts", "file12.ts", false},
		{"file?.ts", "file/.ts", false},
		{"a/**b", "ab", false},
		{"a/**b", "a/zzb", true},
		{"***", "a/b/c", true},
		{"***/x", "a/b/x", true},
		{".env", ".env.local", false},
		{"a/b", "a/b/c", false},
	}
	for _, c := range cases {
		if got := MatchGlob(c.pat, c.tgt); got != c.want {
			t.Errorf("MatchGlob(%q, %q) = %v, want %v", c.pat, c.tgt, got, c.want)
		}
	}
}

func TestMatchGlobLinear(t *testing.T) {
	pat := strings.Repeat("**a", 20)
	tgt := strings.Repeat("a", 64) + "b"
	start := time.Now()
	if MatchGlob(pat, tgt) {
		t.Fatalf("pathological pattern should not match")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("MatchGlob took %v, expected linear (<500ms)", elapsed)
	}
}

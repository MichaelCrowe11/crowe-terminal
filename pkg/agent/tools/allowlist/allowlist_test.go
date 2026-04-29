// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package allowlist

import (
	"sync"
	"testing"
)

func resetForTest() {
	storeLock.Lock()
	store = defaultPatterns()
	storeLock.Unlock()
	loadOnce = sync.Once{}
	loadOnce.Do(func() {})
}

func TestDefaultsCheck(t *testing.T) {
	resetForTest()
	cases := map[string]bool{
		"git status":        true,
		"git log --oneline": true,
		"ls -la":            true,
		"cat README.md":     true,
		"ps aux":            true,
		"node --version":    true,
		// must not match
		"rm -rf /":           false,
		"git push":           false,
		"npm install foo":    false,
		"sudo true":          false,
		"unknown thing here": false,
	}
	for cand, want := range cases {
		got := Check(KindCommand, cand)
		if got != want {
			t.Errorf("Check(command, %q) = %v, want %v", cand, got, want)
		}
	}
}

func TestAddRefusesMutating(t *testing.T) {
	resetForTest()
	if err := Add(Pattern{Kind: KindCommand, Pattern: "rm *"}); err == nil {
		t.Fatalf("expected error adding mutating pattern, got nil")
	}
	if Check(KindCommand, "rm /tmp/x") {
		t.Fatalf("denylist override leaked through allowlist")
	}
}

func TestGlobMatching(t *testing.T) {
	if !matchPattern("git log *", "git log --oneline") {
		t.Errorf("glob should match")
	}
	if matchPattern("git log *", "git push") {
		t.Errorf("glob should not match")
	}
	if !matchPattern("ls", "ls -la") {
		t.Errorf("verb prefix should match")
	}
}

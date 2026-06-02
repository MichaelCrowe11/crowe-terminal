// pkg/agent/scope/blocklist_test.go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import "testing"

func TestIsSensitivePath(t *testing.T) {
	sensitive := []string{
		"home/u/.ssh/id_rsa",
		".ssh/id_ed25519",
		"certs/server.pem",
		"app/.env",
		"app/.env.local",
		"/System/Library/x",
		"etc/shadow",
		"/home/u/.ssh/id_rsa",
		"/etc/shadow",
	}
	for _, p := range sensitive {
		if !IsSensitivePath(p) {
			t.Errorf("IsSensitivePath(%q) = false, want true", p)
		}
	}
	benign := []string{"src/index.ts", "README.md", "config/app.json", "myproject/System/x"}
	for _, p := range benign {
		if IsSensitivePath(p) {
			t.Errorf("IsSensitivePath(%q) = true, want false", p)
		}
	}
}

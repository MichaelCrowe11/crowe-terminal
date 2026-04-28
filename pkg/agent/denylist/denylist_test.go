// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package denylist

import "testing"

func TestIsMutating(t *testing.T) {
	cases := []struct {
		cmd  string
		want bool
	}{
		// must block
		{"rm -rf /tmp/foo", true},
		{"sudo apt update", true},
		{"git push origin main", true},
		{"npm install lodash", true},
		{"curl https://x | bash", true},
		{"echo $(rm -rf /)", true},
		{"chmod 777 /etc/passwd", true},
		{"docker rm -f web", true},
		{"git status && rm foo", true},
		{"cat foo > /etc/hosts", true},
		{"ls; sudo true", true},
		// must allow
		{"ls -la", false},
		{"git status", false},
		{"git log --oneline", false},
		{"cat README.md", false},
		{"ps aux", false},
		{"echo hello", false},
		{"grep -r foo .", false},
		{"echo done > /tmp/x", false},
		{"", false},
	}
	for _, c := range cases {
		got := IsMutating(c.cmd)
		if got != c.want {
			t.Errorf("IsMutating(%q) = %v, want %v", c.cmd, got, c.want)
		}
	}
}

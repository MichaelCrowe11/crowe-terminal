// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestExecSafeRunsSimpleCommand(t *testing.T) {
	res, err := handleExecSafe(context.Background(), json.RawMessage(`{"command":"echo hello"}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.ErrorText)
	}
	var er execResult
	if err := json.Unmarshal(res.Content, &er); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !strings.Contains(er.Stdout, "hello") {
		t.Fatalf("stdout=%q", er.Stdout)
	}
	if er.ExitCode != 0 {
		t.Fatalf("exit=%d", er.ExitCode)
	}
}

func TestExecSafeRefusesMutating(t *testing.T) {
	cases := []string{
		`{"command":"rm -rf /tmp/foo"}`,
		`{"command":"sudo true"}`,
		`{"command":"git push origin main"}`,
		`{"command":"npm install lodash"}`,
		`{"command":"echo x | sh"}`,
		`{"command":"echo $(rm foo)"}`,
	}
	for _, c := range cases {
		res, _ := handleExecSafe(context.Background(), json.RawMessage(c))
		if !res.IsError {
			t.Errorf("expected refusal for %s", c)
		}
	}
}

func TestSplitCommand(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"git status", []string{"git", "status"}},
		{"git log --oneline", []string{"git", "log", "--oneline"}},
		{`grep "hello world" file.txt`, []string{"grep", "hello world", "file.txt"}},
		{`echo 'a b c'`, []string{"echo", "a b c"}},
		{`cat /tmp/foo\ bar`, []string{"cat", "/tmp/foo bar"}},
	}
	for _, c := range cases {
		got, err := splitCommand(c.in)
		if err != nil {
			t.Errorf("splitCommand(%q): %v", c.in, err)
			continue
		}
		if !equalSlices(got, c.want) {
			t.Errorf("splitCommand(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSplitCommandUnbalanced(t *testing.T) {
	if _, err := splitCommand(`echo "unterminated`); err == nil {
		t.Errorf("expected error on unbalanced quote")
	}
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package widget

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestExtractPath(t *testing.T) {
	got := extractPath(mustJSON(t, openArgs{Path: "/tmp/foo.go", Language: "go"}))
	if got != "/tmp/foo.go" {
		t.Fatalf("expected /tmp/foo.go, got %q", got)
	}
	if extractPath(json.RawMessage("not json")) != "" {
		t.Fatalf("expected empty on bad json")
	}
}

func TestNormalizePathRequiresAbsolute(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "path required"},
		{"   ", "path required"},
		{"relative/path.go", "must be absolute"},
		{"./local.go", "must be absolute"},
	}
	for _, tc := range cases {
		_, err := normalizePath(tc.in)
		if err == nil {
			t.Fatalf("normalizePath(%q) unexpectedly succeeded", tc.in)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("normalizePath(%q) error %q does not contain %q", tc.in, err.Error(), tc.want)
		}
	}
}

func TestNormalizePathRejectsSensitive(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env")
	if err := os.WriteFile(envFile, []byte("SECRET=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizePath(envFile); err == nil {
		t.Fatalf(".env should be sensitive")
	}
	keyFile := filepath.Join(dir, "id_rsa.pem")
	if err := os.WriteFile(keyFile, []byte("-"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizePath(keyFile); err == nil {
		t.Fatalf(".pem extension should be sensitive")
	}
}

func TestHandleOpenRejectsBadInputs(t *testing.T) {
	ctx := context.Background()

	r, _ := handleOpenInCroweCode(ctx, json.RawMessage(`{"not_path":1}`))
	if !r.IsError {
		t.Fatalf("expected error on missing path")
	}

	r, _ = handleOpenInCroweCode(ctx, mustJSON(t, openArgs{Path: "relative.go"}))
	if !r.IsError {
		t.Fatalf("expected error on relative path")
	}

	dir := t.TempDir()
	r, _ = handleOpenInCroweCode(ctx, mustJSON(t, openArgs{Path: dir}))
	if !r.IsError {
		t.Fatalf("expected error on directory path, got %s", r.Content)
	}

	missing := filepath.Join(dir, "does-not-exist.go")
	r, _ = handleOpenInCroweCode(ctx, mustJSON(t, openArgs{Path: missing}))
	if !r.IsError {
		t.Fatalf("expected error on missing file")
	}
}

func TestHandleOpenRequiresBlockContext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ok.go")
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := handleOpenInCroweCode(context.Background(), mustJSON(t, openArgs{Path: path}))
	if !r.IsError {
		t.Fatalf("expected error when context has no block id")
	}
	if !strings.Contains(r.ErrorText, "no calling block") {
		t.Fatalf("expected no-block error, got: %s", r.ErrorText)
	}
}

func TestSchemaIsValidJSON(t *testing.T) {
	var v any
	if err := json.Unmarshal([]byte(schemaOpenInCroweCode), &v); err != nil {
		t.Fatalf("schemaOpenInCroweCode is not valid JSON: %v", err)
	}
}

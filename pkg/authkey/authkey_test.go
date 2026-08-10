// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteSharedKeyFileWritesKeyWith0600(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authkey = "test-key-123"
	t.Cleanup(func() { authkey = "" })

	if err := WriteSharedKeyFile(); err != nil {
		t.Fatalf("WriteSharedKeyFile: %v", err)
	}

	path, err := sharedKeyFilePath()
	if err != nil {
		t.Fatalf("sharedKeyFilePath: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if string(data) != "test-key-123" {
		t.Fatalf("token file = %q, want %q", string(data), "test-key-123")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat token file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token file perms = %o, want 600", perm)
	}
	if !strings.HasPrefix(path, home) {
		t.Fatalf("token path %q not under HOME %q", path, home)
	}
	if dir := filepath.Base(filepath.Dir(path)); dir != ".crowe-logic" {
		t.Fatalf("token dir = %q, want .crowe-logic", dir)
	}
}

func TestWriteSharedKeyFileErrorsWhenKeyUnset(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	authkey = ""
	if err := WriteSharedKeyFile(); err == nil {
		t.Fatal("expected error when auth key is unset, got nil")
	}
}

func TestRemoveSharedKeyFileIsIdempotent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := RemoveSharedKeyFile(); err != nil {
		t.Fatalf("RemoveSharedKeyFile on absent file should be nil, got %v", err)
	}
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package editor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func decodeContent(t *testing.T, r registry.Result) map[string]any {
	t.Helper()
	if r.IsError {
		t.Fatalf("unexpected error result: %s", r.ErrorText)
	}
	var out map[string]any
	if err := json.Unmarshal(r.Content, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestReadWriteRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")

	w, _ := handleWriteFile(context.Background(), mustJSON(t, writeArgs{Path: path, Contents: "hello world\n"}))
	out := decodeContent(t, w)
	if out["created"] != true {
		t.Fatalf("expected created=true, got %v", out["created"])
	}

	r, _ := handleReadFile(context.Background(), mustJSON(t, readArgs{Path: path}))
	got := decodeContent(t, r)
	if got["contents"] != "hello world\n" {
		t.Fatalf("contents mismatch: %v", got["contents"])
	}
}

func TestApplyEditUniqueMatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "code.go")
	original := "package main\nfunc oldName() {}\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	r, _ := handleApplyEdit(context.Background(), mustJSON(t, editArgs{
		Path:    path,
		OldText: "oldName",
		NewText: "newName",
	}))
	out := decodeContent(t, r)
	if out["changed"] != true {
		t.Fatalf("expected changed=true: %v", out)
	}
	updated, _ := os.ReadFile(path)
	if !strings.Contains(string(updated), "newName") {
		t.Fatalf("file not updated: %s", updated)
	}
}

func TestApplyEditAmbiguous(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ambig.txt")
	if err := os.WriteFile(path, []byte("foo\nfoo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := handleApplyEdit(context.Background(), mustJSON(t, editArgs{
		Path: path, OldText: "foo", NewText: "bar",
	}))
	if !r.IsError {
		t.Fatalf("expected ambiguous match to error, got %s", r.Content)
	}
	if !strings.Contains(r.ErrorText, "appears 2 times") {
		t.Fatalf("error should mention duplicate match count: %s", r.ErrorText)
	}
}

func TestApplyEditMissingMatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "no.txt")
	if err := os.WriteFile(path, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := handleApplyEdit(context.Background(), mustJSON(t, editArgs{
		Path: path, OldText: "missing", NewText: "anything",
	}))
	if !r.IsError {
		t.Fatalf("expected error for missing old_text")
	}
}

func TestApplyEditNoOp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "same.txt")
	if err := os.WriteFile(path, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := handleApplyEdit(context.Background(), mustJSON(t, editArgs{
		Path: path, OldText: "hi", NewText: "hi",
	}))
	out := decodeContent(t, r)
	if out["changed"] != false {
		t.Fatalf("expected no-op")
	}
}

func TestRejectsRelativePath(t *testing.T) {
	r, _ := handleReadFile(context.Background(), mustJSON(t, readArgs{Path: "relative/path.txt"}))
	if !r.IsError {
		t.Fatalf("expected error for relative path")
	}
}

func TestRejectsSensitiveLocations(t *testing.T) {
	cases := []string{
		"/etc/ssh/sshd_config",
		"/Users/anyone/.aws/credentials",
		"/Users/anyone/.ssh/id_rsa",
		"/Users/anyone/project/.env",
		"/Users/anyone/project/.env.production",
		"/Users/anyone/keys/server.pem",
	}
	for _, p := range cases {
		_, err := normalizePath(p)
		if err == nil {
			t.Errorf("expected %s to be rejected", p)
		}
	}
}

func TestRejectsBinaryRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "binary.bin")
	data := []byte{0x00, 0x01, 0x02, 0x00}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := handleReadFile(context.Background(), mustJSON(t, readArgs{Path: path}))
	if !r.IsError {
		t.Fatalf("expected binary read to be rejected")
	}
}

type captureClient struct {
	ch chan wps.WaveEvent
}

func (c *captureClient) SendEvent(routeId string, event wps.WaveEvent) {
	c.ch <- event
}

func waitFileChange(t *testing.T, ch chan wps.WaveEvent) wps.CroweCodeFileChangeData {
	t.Helper()
	select {
	case ev := <-ch:
		data, ok := ev.Data.(wps.CroweCodeFileChangeData)
		if !ok {
			t.Fatalf("event data is %T, want CroweCodeFileChangeData", ev.Data)
		}
		return data
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for crowecode:filechange event")
		return wps.CroweCodeFileChangeData{}
	}
}

func TestPublishesFileChangeEvent(t *testing.T) {
	cap := &captureClient{ch: make(chan wps.WaveEvent, 8)}
	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(cap)
	defer wps.Broker.SetClient(prev)

	dir := t.TempDir()
	path := filepath.Join(dir, "live.txt")
	abs, err := normalizePath(path)
	if err != nil {
		t.Fatal(err)
	}
	wps.Broker.Subscribe("test-route", wps.SubscriptionRequest{
		Event:  wps.Event_CroweCodeFileChange,
		Scopes: []string{abs},
	})
	defer wps.Broker.UnsubscribeAll("test-route")

	handleWriteFile(context.Background(), mustJSON(t, writeArgs{Path: path, Contents: "v1\n"}))
	wrote := waitFileChange(t, cap.ch)
	if wrote.Path != abs || wrote.Op != "write" {
		t.Fatalf("write event mismatch: got %+v, want path=%s op=write", wrote, abs)
	}

	handleApplyEdit(context.Background(), mustJSON(t, editArgs{Path: path, OldText: "v1", NewText: "v2"}))
	edited := waitFileChange(t, cap.ch)
	if edited.Path != abs || edited.Op != "edit" {
		t.Fatalf("edit event mismatch: got %+v, want path=%s op=edit", edited, abs)
	}
}

func TestNoEventOnFailedEdit(t *testing.T) {
	cap := &captureClient{ch: make(chan wps.WaveEvent, 8)}
	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(cap)
	defer wps.Broker.SetClient(prev)

	dir := t.TempDir()
	path := filepath.Join(dir, "ambig.txt")
	if err := os.WriteFile(path, []byte("foo\nfoo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	abs, _ := normalizePath(path)
	wps.Broker.Subscribe("test-route-2", wps.SubscriptionRequest{
		Event:  wps.Event_CroweCodeFileChange,
		Scopes: []string{abs},
	})
	defer wps.Broker.UnsubscribeAll("test-route-2")

	handleApplyEdit(context.Background(), mustJSON(t, editArgs{Path: path, OldText: "foo", NewText: "bar"}))
	select {
	case ev := <-cap.ch:
		t.Fatalf("ambiguous edit must not publish, got %+v", ev)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestRecentTracking(t *testing.T) {
	recentLock.Lock()
	recentList = nil
	recentLock.Unlock()

	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	b := filepath.Join(dir, "b.txt")
	handleWriteFile(context.Background(), mustJSON(t, writeArgs{Path: a, Contents: "a"}))
	handleWriteFile(context.Background(), mustJSON(t, writeArgs{Path: b, Contents: "b"}))
	handleReadFile(context.Background(), mustJSON(t, readArgs{Path: a}))

	r, _ := handleListRecent(context.Background(), json.RawMessage("{}"))
	out := decodeContent(t, r)
	count, _ := out["count"].(float64)
	if int(count) != 2 {
		t.Fatalf("expected 2 recent entries, got %v", count)
	}
	entries, _ := out["recent"].([]any)
	normalizedA, _ := normalizePath(a)
	if len(entries) > 0 {
		first := entries[0].(map[string]any)
		if first["path"] != normalizedA || first["op"] != "read" {
			t.Fatalf("expected most-recent to be read of %s, got %v", normalizedA, first)
		}
	}
}

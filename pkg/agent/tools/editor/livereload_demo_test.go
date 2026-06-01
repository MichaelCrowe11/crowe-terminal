// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package editor

// Terminal demo of the live-reload loop. It drives the REAL editor.* tools and
// the REAL wps broker; the fakeBlock mirrors the frontend CroweCodeViewModel's
// reconcile (loadFromDisk when clean, conflict flag when dirty) so the
// end-to-end contract is observable in `go test -v` without launching the GUI.
//
//   go test ./pkg/agent/tools/editor/ -run TestLiveReloadDemo -v

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wps"
)

// fakeBlock stands in for an open Crowe Code block bound to a file.
type fakeBlock struct {
	path        string
	buffer      string // what the editor shows
	saved       string // last-known on-disk text
	diskChanged bool
	done        chan struct{}
}

func (b *fakeBlock) dirty() bool { return b.buffer != b.saved }

// SendEvent is the wps.Client hook; it mirrors handleFileChange in the model.
func (b *fakeBlock) SendEvent(routeId string, event wps.WaveEvent) {
	data, ok := event.Data.(wps.CroweCodeFileChangeData)
	if !ok || data.Path != b.path {
		return
	}
	if b.dirty() {
		b.diskChanged = true
		fmt.Printf("  ⚠️  disk changed (op=%s) but buffer is dirty → conflict flag raised, buffer untouched\n", data.Op)
	} else {
		disk, _ := os.ReadFile(b.path)
		b.buffer = string(disk)
		b.saved = string(disk)
		fmt.Printf("  🔄 disk changed (op=%s) and buffer clean → live-reloaded buffer to %q\n", data.Op, b.buffer)
	}
	select {
	case b.done <- struct{}{}:
	default:
	}
}

func (b *fakeBlock) arm() { b.done = make(chan struct{}, 1) }

func (b *fakeBlock) wait(t *testing.T) {
	t.Helper()
	select {
	case <-b.done:
	case <-time.After(2 * time.Second):
		t.Fatal("block never received the file-change event")
	}
}

func TestLiveReloadDemo(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "service.go")
	abs, _ := normalizePath(path)

	// Seed the file directly (no tool, no event) so setup doesn't leak a
	// stale change into the subscribed window.
	if err := os.WriteFile(path, []byte("func handler() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	block := &fakeBlock{path: abs, buffer: "func handler() {}\n", saved: "func handler() {}\n"}

	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(block)
	defer wps.Broker.SetClient(prev)
	wps.Broker.Subscribe("demo-block", wps.SubscriptionRequest{Event: wps.Event_CroweCodeFileChange, Scopes: []string{abs}})
	defer wps.Broker.UnsubscribeAll("demo-block")

	fmt.Println("\n── Scenario A: AI edits a file the user is NOT touching ──")
	fmt.Printf("  block buffer before: %q (dirty=%v)\n", block.buffer, block.dirty())
	block.arm()
	fmt.Println("  agent runs editor.apply_edit: handler → handleRequest")
	handleApplyEdit(context.Background(), mustJSON(t, editArgs{Path: path, OldText: "handler", NewText: "handleRequest"}))
	block.wait(t)
	if block.buffer != "func handleRequest() {}\n" {
		t.Fatalf("buffer should have live-reloaded, got %q", block.buffer)
	}
	fmt.Printf("  block buffer after:  %q ✅ no save, no refresh click\n", block.buffer)

	fmt.Println("\n── Scenario B: AI edits a file with UNSAVED user edits ──")
	block.buffer = "func handleRequest() { /* user typing... */ }\n" // user made local edits
	fmt.Printf("  block buffer before: %q (dirty=%v)\n", block.buffer, block.dirty())
	block.arm()
	fmt.Println("  agent runs editor.write_file")
	handleWriteFile(context.Background(), mustJSON(t, writeArgs{Path: path, Contents: "func handleRequest() { return }\n"}))
	block.wait(t)
	if !block.diskChanged {
		t.Fatal("expected conflict flag")
	}
	if block.buffer != "func handleRequest() { /* user typing... */ }\n" {
		t.Fatalf("dirty buffer must NOT be clobbered, got %q", block.buffer)
	}
	fmt.Printf("  block buffer after:  %q ✅ user edits preserved, header shows \"changed on disk\"\n\n", block.buffer)
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package livewatch

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wps"
)

type captureClient struct {
	ch chan wps.WaveEvent
}

func (c *captureClient) SendEvent(routeId string, event wps.WaveEvent) {
	c.ch <- event
}

func TestExternalWritePublishesEvent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Clean(filepath.Join(dir, "external.go"))
	if err := os.WriteFile(path, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cap := &captureClient{ch: make(chan wps.WaveEvent, 16)}
	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(cap)
	defer wps.Broker.SetClient(prev)
	wps.Broker.Subscribe("livewatch-test", wps.SubscriptionRequest{
		Event:  wps.Event_CroweCodeFileChange,
		Scopes: []string{path},
	})
	defer wps.Broker.UnsubscribeAll("livewatch-test")

	Watch(path)
	defer Unwatch(path)

	// Give fsnotify a beat to register the directory before mutating.
	time.Sleep(150 * time.Millisecond)
	if err := os.WriteFile(path, []byte("v2-external\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case ev := <-cap.ch:
		data, ok := ev.Data.(wps.CroweCodeFileChangeData)
		if !ok {
			t.Fatalf("event data is %T, want CroweCodeFileChangeData", ev.Data)
		}
		if data.Path != path {
			t.Fatalf("event path = %q, want %q", data.Path, path)
		}
		if data.Op != OpExternal {
			t.Fatalf("event op = %q, want %q", data.Op, OpExternal)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for external-change event")
	}
}

func TestReWatchSelfHeals(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Clean(filepath.Join(dir, "reopen.go"))
	if err := os.WriteFile(path, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cap := &captureClient{ch: make(chan wps.WaveEvent, 16)}
	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(cap)
	defer wps.Broker.SetClient(prev)
	wps.Broker.Subscribe("livewatch-reopen", wps.SubscriptionRequest{
		Event:  wps.Event_CroweCodeFileChange,
		Scopes: []string{path},
	})
	defer wps.Broker.UnsubscribeAll("livewatch-reopen")

	// Open, then close (this Removes the dir watch), then re-open — mirrors a
	// block being torn down and re-created (e.g. a dev HMR remount).
	Watch(path)
	Unwatch(path)
	Watch(path)
	defer Unwatch(path)

	time.Sleep(150 * time.Millisecond)
	if err := os.WriteFile(path, []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case ev := <-cap.ch:
		data := ev.Data.(wps.CroweCodeFileChangeData)
		if data.Path != path {
			t.Fatalf("event path = %q, want %q", data.Path, path)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("re-watch did not re-arm: no event after reopen + external edit")
	}
}

func TestRefCounting(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Clean(filepath.Join(dir, "a.txt"))
	b := filepath.Clean(filepath.Join(dir, "b.txt"))

	start := WatchCount()

	Watch(a)
	Watch(a) // second open block on same file
	Watch(b)
	if got := WatchCount() - start; got != 2 {
		t.Fatalf("distinct watched files = %d, want 2", got)
	}

	Unwatch(a) // one block of two closes; file still watched
	if got := WatchCount() - start; got != 2 {
		t.Fatalf("after one unwatch, distinct files = %d, want 2", got)
	}

	Unwatch(a) // last block on a closes
	Unwatch(b)
	if got := WatchCount() - start; got != 0 {
		t.Fatalf("after all unwatch, distinct files = %d, want 0", got)
	}

	// Unbalanced unwatch must be a no-op, not go negative.
	Unwatch(a)
	if got := WatchCount() - start; got != 0 {
		t.Fatalf("unbalanced unwatch changed count: %d", got)
	}
}

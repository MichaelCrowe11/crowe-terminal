// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeOSStore(t *testing.T) (*osStore, *string) {
	t.Helper()
	s := makeOSStore(t.TempDir())
	token := ""
	s.keyring = keyringAPI{
		get:    func(string, string) (string, error) { return token, nil },
		set:    func(_, _, value string) error { token = value; return nil },
		delete: func(string, string) error { token = ""; return nil },
	}
	return s, &token
}

func TestOSStoreDurabilityAndTombstone(t *testing.T) {
	s, token := fakeOSStore(t)
	ctx := context.Background()
	*token = "fake-orphan-secret"
	if got, err := s.Load(ctx); err != nil || got != "" {
		t.Fatal("orphan credential loaded without ready marker")
	}
	if err := s.Save(ctx, "fake-refresh-secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Load(ctx); err != nil || got != "fake-refresh-secret" {
		t.Fatal("saved credential unavailable")
	}
	data, err := os.ReadFile(filepath.Join(s.dir, "state"))
	if err != nil || !strings.HasPrefix(string(data), markerReady) {
		t.Fatal("ready marker missing")
	}
	entries, _ := os.ReadDir(s.dir)
	for _, entry := range entries {
		data, _ := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		if strings.Contains(string(data), "fake-") {
			t.Fatal("secret persisted to plaintext")
		}
	}
	s.keyring.delete = func(string, string) error {
		data, err := os.ReadFile(filepath.Join(s.dir, "state"))
		if err != nil || string(data) != markerBlocked {
			t.Error("delete preceded tombstone")
		}
		return errors.New("fake-keyring-secret")
	}
	if err := s.Delete(ctx); !errors.Is(err, errStorage) {
		t.Fatal("delete failure hidden")
	}
	if got, err := s.Load(ctx); got != "" || err != nil {
		t.Fatal("delete failure resurrected credential")
	}
}

func TestOSStoreRejectsStaleKeyringCommit(t *testing.T) {
	s, token := fakeOSStore(t)
	ctx := context.Background()
	if err := s.Save(ctx, "fake-original"); err != nil {
		t.Fatal(err)
	}
	oldRecord := *token
	if err := s.Save(ctx, "fake-rotated"); err != nil {
		t.Fatal(err)
	}
	*token = oldRecord
	if got, err := s.Load(ctx); err != nil || got != "" {
		t.Fatal("old keyring record matched new commit marker")
	}
}

func TestOSStoreReadbackFailureRemainsBlocked(t *testing.T) {
	s, _ := fakeOSStore(t)
	s.keyring.set = func(string, string, string) error { return nil }
	if err := s.Save(context.Background(), "fake-token"); err == nil {
		t.Fatal("failed write accepted")
	}
	if got, err := s.Load(context.Background()); got != "" || err != nil {
		t.Fatal("unverified keyring record accepted")
	}
}

func TestOSStoreWriteFailureRemainsBlocked(t *testing.T) {
	s, _ := fakeOSStore(t)
	if err := s.Save(context.Background(), "fake-original"); err != nil {
		t.Fatal(err)
	}
	s.keyring.set = func(string, string, string) error { return errors.New("fake-secret") }
	if err := s.Save(context.Background(), "fake-rotated"); err == nil || strings.Contains(err.Error(), "fake-secret") {
		t.Fatal("unsafe storage error")
	}
	if got, err := s.Load(context.Background()); got != "" || err != nil {
		t.Fatal("stale refresh reusable")
	}
}

func TestKeyringLimitsAndProfileScope(t *testing.T) {
	account := strings.Repeat("a", 64)
	for _, platform := range []string{"darwin", "windows"} {
		if !fitsKeyring(platform, account, "fake-small-token") {
			t.Fatal("small token rejected")
		}
		if fitsKeyring(platform, account, strings.Repeat("x", 4096)) {
			t.Fatal("oversized token accepted")
		}
	}
	largest := 0
	for i := 1; i < 4096; i++ {
		if fitsKeyring("darwin", account, strings.Repeat("x", i)) {
			largest = i
		}
	}
	if largest >= 3000 || largest < 2800 {
		t.Fatalf("unexpected encoded limit: %d", largest)
	}
	if !fitsKeyring("windows", account, strings.Repeat("x", 2560)) || fitsKeyring("windows", account, strings.Repeat("x", 2561)) {
		t.Fatal("Windows byte limit incorrect")
	}
	a := makeOSStore(t.TempDir())
	b := makeOSStore(t.TempDir())
	if a.account == b.account || len(a.account) != 64 || strings.Contains(a.account, a.dir) {
		t.Fatal("profile isolation failed")
	}
	if _, err := makeOSStore("").Load(context.Background()); err == nil {
		t.Fatal("empty profile must fail closed")
	}
}

func TestDisconnectFailureStillInvalidates(t *testing.T) {
	store := &fakeStore{token: "fake-refresh", failDelete: true}
	m := testManager(store, func(*http.Request) (*http.Response, error) { t.Fatal("must not make request"); return nil, errRequest })
	status, err := m.Disconnect(context.Background())
	if err == nil || status.State != StateSignedOut {
		t.Fatal("local disconnect failed")
	}
	if _, err = m.Token(context.Background()); !errors.Is(err, ErrSignInRequired) {
		t.Fatal("disconnect retained session")
	}
	if strings.Contains(status.Message, "fake-") {
		t.Fatal("storage error leak")
	}
}

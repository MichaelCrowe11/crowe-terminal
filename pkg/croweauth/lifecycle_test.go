// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type blockingStore struct {
	*fakeStore
	operation string
	entered   chan struct{}
	release   chan struct{}
	once      sync.Once
}

func (s *blockingStore) pause(operation string) {
	if s.operation == operation {
		s.once.Do(func() { close(s.entered) })
		<-s.release
	}
}

func (s *blockingStore) Load(ctx context.Context) (string, error) {
	s.pause("load")
	return s.fakeStore.Load(ctx)
}

func (s *blockingStore) Save(ctx context.Context, token string) error {
	s.pause("save")
	// OS keyring calls may complete even after their caller's context is canceled.
	return s.fakeStore.Save(context.WithoutCancel(ctx), token)
}

func TestDisconnectCancelsRequestsBeforeBlockedKeyringReturns(t *testing.T) {
	for _, operation := range []string{"load", "save"} {
		t.Run(operation, func(t *testing.T) {
			store := &blockingStore{
				fakeStore: &fakeStore{token: "fake-refresh"}, operation: operation,
				entered: make(chan struct{}), release: make(chan struct{}),
			}
			m := MakeManager(Dependencies{Store: store, Client: &http.Client{Transport: fakeTransport(func(*http.Request) (*http.Response, error) {
				return response(200, tokenBody), nil
			})}})
			session, cancel := m.SessionContext(context.Background())
			defer cancel()
			tokenDone := make(chan struct{})
			go func() {
				defer close(tokenDone)
				if token, err := m.Token(context.Background()); token != "" || err == nil {
					t.Error("blocked operation published a token after disconnect began")
				}
			}()
			waitSignal(t, store.entered)
			disconnected := make(chan struct{})
			go func() {
				defer close(disconnected)
				if _, err := m.Disconnect(context.Background()); err != nil {
					t.Error(err)
				}
			}()
			waitSignal(t, session.Done())
			select {
			case <-disconnected:
				t.Fatal("disconnect claimed durable cleanup before keyring returned")
			default:
			}
			close(store.release)
			waitSignal(t, tokenDone)
			waitSignal(t, disconnected)
			waitState(t, m, StateSignedOut)
			store.mu.Lock()
			defer store.mu.Unlock()
			if !store.blocked || store.token != "" {
				t.Fatal("late save resurrected disconnected credentials")
			}
		})
	}
}

func TestCancelDuringPendingSaveCannotCompleteSignIn(t *testing.T) {
	store := &blockingStore{fakeStore: &fakeStore{}, operation: "save", entered: make(chan struct{}), release: make(chan struct{})}
	pollReady := make(chan struct{})
	m := MakeManager(Dependencies{Store: store, Wait: func(context.Context, time.Duration) error { <-pollReady; return nil }, Client: &http.Client{Transport: fakeTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/auth/device") {
			return response(200, deviceBody), nil
		}
		return response(200, tokenBody), nil
	})}})
	if _, err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	close(pollReady)
	waitSignal(t, store.entered)
	canceled := make(chan struct{})
	go func() {
		defer close(canceled)
		if status, err := m.Cancel(context.Background()); err != nil || status.State != StateSignedOut {
			t.Error("pending sign-in did not cancel")
		}
	}()
	waitSignal(t, session.Done())
	close(store.release)
	waitSignal(t, canceled)
	if token, err := m.Token(context.Background()); token != "" || err == nil {
		t.Fatal("canceled sign-in published credentials")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.blocked || store.token != "" {
		t.Fatal("canceled sign-in retained late keyring write")
	}
}

func TestCancelDoesNotInvalidateConnectedAccount(t *testing.T) {
	m := testManager(&fakeStore{token: "fake-refresh"}, func(*http.Request) (*http.Response, error) { return response(200, tokenBody), nil })
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	if _, err := m.Token(session); err != nil {
		t.Fatal(err)
	}
	if status, err := m.Cancel(context.Background()); err != nil || status.State != StateConnected || session.Err() != nil {
		t.Fatal("unrelated cancel invalidated connected account")
	}
}

func TestPendingDisconnectCancelsReplacementSession(t *testing.T) {
	m := testManager(&fakeStore{}, func(*http.Request) (*http.Response, error) {
		t.Fatal("unexpected network call")
		return nil, errRequest
	})
	m.beginDisconnect()
	func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.advanceLocked()
	}()
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	if session.Err() == nil {
		t.Fatal("replacement session escaped pending disconnect")
	}
	func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.endDisconnectLocked()
	}()
}

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "com.crowelogic.hypheus.crowe-account"
	markerBlocked  = "blocked\n"
	markerReady    = "ready\n"
)

type keyringAPI struct {
	get    func(string, string) (string, error)
	set    func(string, string, string) error
	delete func(string, string) error
}

type osStore struct {
	dir     string
	account string
	keyring keyringAPI
}

func makeOSStore(profile string) *osStore {
	s := &osStore{keyring: keyringAPI{get: keyring.Get, set: keyring.Set, delete: keyring.Delete}}
	if profile == "" {
		return s
	}
	absolute, err := filepath.Abs(profile)
	if err != nil {
		return s
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	}
	digest := sha256.Sum256([]byte(absolute))
	s.account = hex.EncodeToString(digest[:])
	s.dir = filepath.Join(absolute, ".crowe-account")
	return s
}

func (s *osStore) Load(ctx context.Context) (string, error) {
	if ctx.Err() != nil || s.dir == "" {
		return "", errStorage
	}
	f, err := os.Open(filepath.Join(s.dir, "state"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", errStorage
	}
	defer f.Close()
	state, err := io.ReadAll(io.LimitReader(f, 64))
	if err != nil {
		return "", errStorage
	}
	if !strings.HasPrefix(string(state), markerReady) {
		return "", nil
	}
	commit := strings.TrimPrefix(string(state), markerReady)
	if decoded, err := hex.DecodeString(commit); err != nil || len(decoded) != 16 {
		return "", nil
	}
	token, err := s.keyring.get(keyringService, s.account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", errStorage
	}
	if !strings.HasPrefix(token, commit+"\n") {
		return "", nil
	}
	return strings.TrimPrefix(token, commit+"\n"), nil
}

func (s *osStore) Block(ctx context.Context) error {
	if ctx.Err() != nil {
		return errStorage
	}
	return s.writeMarker(markerBlocked)
}

func (s *osStore) Save(ctx context.Context, token string) error {
	if err := s.Block(ctx); err != nil {
		return errStorage
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil || token == "" {
		return errStorage
	}
	commit := hex.EncodeToString(nonce[:])
	// A commit ID prevents an older keyring record surviving a crash from matching a newer marker.
	record := commit + "\n" + token
	if !fitsKeyring(runtime.GOOS, s.account, record) {
		return errStorage
	}
	if err := s.keyring.set(keyringService, s.account, record); err != nil {
		return errStorage
	}
	// macOS security's interactive process exit alone does not prove the write succeeded.
	saved, err := s.keyring.get(keyringService, s.account)
	if err != nil || saved != record || ctx.Err() != nil {
		return errStorage
	}
	if err := s.writeMarker(markerReady + commit); err != nil {
		_ = s.writeMarker(markerBlocked)
		_ = s.keyring.delete(keyringService, s.account)
		return errStorage
	}
	return nil
}

func (s *osStore) Delete(ctx context.Context) error {
	blockErr := s.Block(ctx)
	if s.account == "" {
		return errStorage
	}
	err := s.keyring.delete(keyringService, s.account)
	if blockErr != nil || err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return errStorage
	}
	return nil
}

func fitsKeyring(platform, account, token string) bool {
	if token == "" {
		return false
	}
	switch platform {
	case "darwin":
		// v0.2.8 starts security before checking its 4096-byte command limit. Preflight
		// the whole command to avoid that error path leaking a process and stdin pipe.
		encoded := "go-keyring-base64:" + base64.StdEncoding.EncodeToString([]byte(token))
		command := "add-generic-password -U -s " + keyringService + " -a " + account + " -w " + encoded + "\n"
		return len(command) <= 4096
	case "windows":
		return len(token) <= 2560
	default:
		return len(token) <= maxResponseBytes
	}
}

func (s *osStore) writeMarker(value string) error {
	if s.dir == "" {
		return errStorage
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return errStorage
	}
	if err := syncDirectory(filepath.Dir(s.dir)); err != nil {
		return errStorage
	}
	f, err := os.CreateTemp(s.dir, ".state-")
	if err != nil {
		return errStorage
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(value); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errStorage
	}
	if err := replaceMarker(f.Name(), filepath.Join(s.dir, "state")); err != nil {
		return errStorage
	}
	if err := syncDirectory(s.dir); err != nil {
		return errStorage
	}
	return nil
}

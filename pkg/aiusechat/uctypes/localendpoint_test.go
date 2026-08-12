// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uctypes

import (
	"errors"
	"net"
	"strings"
	"syscall"
	"testing"
)

func dialErr() error {
	return &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
}

func TestIsLocalEndpoint(t *testing.T) {
	local := []string{
		"http://127.0.0.1:8011/v1/chat/completions",
		"http://localhost:8013/v1/chat/completions",
		"http://[::1]:8011/v1/chat/completions",
	}
	for _, endpoint := range local {
		if !IsLocalEndpoint(endpoint) {
			t.Errorf("IsLocalEndpoint(%q) = false, want true", endpoint)
		}
	}

	remote := []string{
		"https://api.openai.com/v1/chat/completions",
		"https://cfapi.waveterm.dev/api/waveai",
		"",
	}
	for _, endpoint := range remote {
		if IsLocalEndpoint(endpoint) {
			t.Errorf("IsLocalEndpoint(%q) = true, want false", endpoint)
		}
	}
}

func TestLocalEndpointDialErrorNamesTheFoundry(t *testing.T) {
	err := LocalEndpointDialError("http://127.0.0.1:8011/v1/chat/completions", dialErr())
	if err == nil {
		t.Fatal("expected an actionable error for a dead Foundry bridge, got nil")
	}
	if !strings.Contains(err.Error(), "Foundry") {
		t.Errorf("error should name the Foundry, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "127.0.0.1:8011") {
		t.Errorf("error should name the address, got %q", err.Error())
	}
}

func TestLocalEndpointDialErrorOtherLocalPort(t *testing.T) {
	err := LocalEndpointDialError("http://127.0.0.1:8013/v1/chat/completions", dialErr())
	if err == nil {
		t.Fatal("expected an actionable error for a dead local server, got nil")
	}
	if strings.Contains(err.Error(), "Foundry") {
		t.Errorf("a non-8011 port should not be blamed on the Foundry, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "127.0.0.1:8013") {
		t.Errorf("error should name the address, got %q", err.Error())
	}
}

func TestLocalEndpointDialErrorPassesThrough(t *testing.T) {
	// A remote endpoint keeps its original error.
	if err := LocalEndpointDialError("https://api.openai.com/v1/chat/completions", dialErr()); err != nil {
		t.Errorf("remote endpoint should pass through, got %q", err.Error())
	}
	// So does a local endpoint that connected and then failed for another reason.
	other := errors.New("unexpected EOF")
	if err := LocalEndpointDialError("http://127.0.0.1:8011/v1/chat/completions", other); err != nil {
		t.Errorf("non-dial failure should pass through, got %q", err.Error())
	}
	if err := LocalEndpointDialError("http://127.0.0.1:8011/v1/chat/completions", nil); err != nil {
		t.Errorf("nil error should pass through, got %q", err.Error())
	}
}

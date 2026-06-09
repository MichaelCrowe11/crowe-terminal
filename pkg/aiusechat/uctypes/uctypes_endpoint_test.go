// Copyright 2026, Crowe Logic, Inc.
// SPDX-License-Identifier: Apache-2.0

package uctypes

import (
	"net/url"
	"strings"
	"testing"
)

func TestDefaultAIEndpointIsLocal(t *testing.T) {
	if strings.Contains(DefaultAIEndpoint, "waveterm.dev") {
		t.Fatalf("DefaultAIEndpoint references upstream Wave infra: %s", DefaultAIEndpoint)
	}
	u, err := url.Parse(DefaultAIEndpoint)
	if err != nil {
		t.Fatalf("DefaultAIEndpoint does not parse: %v", err)
	}
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
		t.Fatalf("DefaultAIEndpoint must stay on-machine, got host %q", u.Hostname())
	}
}

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"net/http/httptest"
	"os"
	"testing"
)

func TestFrontendProvenanceRequiresSeparateKey(t *testing.T) {
	previousAuth, previousFrontend := authkey, frontendKey
	t.Cleanup(func() { authkey, frontendKey = previousAuth, previousFrontend })
	t.Setenv(WaveAuthKeyEnv, "synthetic-backend-key")
	t.Setenv(frontendKeyEnv, "synthetic-frontend-key")
	if err := SetAuthKeyFromEnv(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(WaveAuthKeyEnv) != "" || os.Getenv(frontendKeyEnv) != "" {
		t.Fatal("keys remain in the child-process environment")
	}
	cases := []struct {
		name     string
		values   []string
		frontend bool
	}{
		{"generic auth only", nil, false},
		{"empty", []string{""}, false},
		{"generic key reused", []string{"synthetic-backend-key"}, false},
		{"wrong", []string{"wrong"}, false},
		{"separate key", []string{"synthetic-frontend-key"}, true},
		{"duplicate", []string{"synthetic-frontend-key", "synthetic-frontend-key"}, false},
		{"combined", []string{"synthetic-frontend-key,synthetic-frontend-key"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://127.0.0.1/ws", nil)
			r.Header.Set(AuthKeyHeader, "synthetic-backend-key")
			for _, value := range tc.values {
				r.Header.Add(frontendKeyHeader, value)
			}
			if err := ValidateIncomingRequest(r); err != nil {
				t.Fatal("generic authenticated clients should remain supported")
			}
			if IsLocalFrontendRequest(r) != tc.frontend {
				t.Fatalf("frontend = %v, want %v", !tc.frontend, tc.frontend)
			}
		})
	}
	frontendKey = ""
	if IsLocalFrontendRequest(httptest.NewRequest("GET", "http://127.0.0.1/ws", nil)) {
		t.Fatal("missing configuration granted frontend provenance")
	}
}

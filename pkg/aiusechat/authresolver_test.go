// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"errors"
	"strings"
	"testing"
)

func TestResolveAPIToken(t *testing.T) {
	const croweSecretName = "CROWE_MODELS_KEY"
	storeErr := errors.New("fictional store unavailable")
	setupError := "Crowe Logic model authentication is not configured. Add a CROWE_MODELS_KEY secret in Settings > Secrets > Add New Secret, or run wsh secret ui"
	tests := []struct {
		name             string
		apiToken         string
		secretName       string
		stored           string
		exists           bool
		storeErr         error
		runtime          string
		want             string
		wantError        string
		wantStoreCalls   int
		wantRuntimeCalls int
	}{
		{
			name: "explicit wins over store and runtime", apiToken: "fictional-explicit", secretName: croweSecretName,
			stored: "fictional-stored", exists: true, runtime: "fictional-runtime", want: "fictional-explicit",
		},
		{
			name: "explicit whitespace preserved", apiToken: " \t\n", secretName: croweSecretName,
			storeErr: storeErr, runtime: "fictional-runtime", want: " \t\n",
		},
		{
			name: "explicit surrounding whitespace preserved", apiToken: " fictional-explicit \n", secretName: "OTHER_API_KEY",
			storeErr: storeErr, runtime: "fictional-runtime", want: " fictional-explicit \n",
		},
		{
			name: "explicit without secret name", apiToken: "fictional-explicit", want: "fictional-explicit",
		},
		{
			name: "unauthenticated custom mode", stored: "fictional-stored", exists: true, runtime: "fictional-runtime",
		},
		{
			name: "stored key wins and is trimmed", secretName: croweSecretName,
			stored: " \tfictional-stored\n ", exists: true, runtime: "fictional-runtime", want: "fictional-stored", wantStoreCalls: 1,
		},
		{
			name: "unrelated stored key", secretName: "OTHER_API_KEY",
			stored: " fictional-stored ", exists: true, runtime: "fictional-runtime", want: "fictional-stored", wantStoreCalls: 1,
		},
		{
			name: "missing stored key uses runtime", secretName: croweSecretName,
			runtime: "fictional-runtime", want: "fictional-runtime", wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "empty stored key uses runtime", secretName: croweSecretName, exists: true,
			runtime: "fictional-runtime", want: "fictional-runtime", wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "whitespace stored key uses runtime", secretName: croweSecretName, stored: " \t\n ", exists: true,
			runtime: "fictional-runtime", want: "fictional-runtime", wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "nonexistent stored value ignored", secretName: croweSecretName, stored: "fictional-stored",
			runtime: "fictional-runtime", want: "fictional-runtime", wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "missing Crowe key setup guidance", secretName: croweSecretName,
			wantError: setupError, wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "empty Crowe key setup guidance", secretName: croweSecretName, exists: true,
			wantError: setupError, wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "whitespace Crowe key setup guidance", secretName: croweSecretName, stored: " \t\n ", exists: true,
			wantError: setupError, wantStoreCalls: 1, wantRuntimeCalls: 1,
		},
		{
			name: "unrelated missing key never uses runtime", secretName: "OTHER_API_KEY", runtime: "fictional-runtime",
			wantError: "secret OTHER_API_KEY not found or empty", wantStoreCalls: 1,
		},
		{
			name: "unrelated blank key never uses runtime", secretName: "OTHER_API_KEY", stored: " \t", exists: true, runtime: "fictional-runtime",
			wantError: "secret OTHER_API_KEY not found or empty", wantStoreCalls: 1,
		},
		{
			name: "unrelated nonexistent value never used", secretName: "OTHER_API_KEY", stored: "fictional-stored", runtime: "fictional-runtime",
			wantError: "secret OTHER_API_KEY not found or empty", wantStoreCalls: 1,
		},
		{
			name: "secret name exact match", secretName: " CROWE_MODELS_KEY", runtime: "fictional-runtime",
			wantError: "secret  CROWE_MODELS_KEY not found or empty", wantStoreCalls: 1,
		},
		{
			name: "store error fails closed despite credentials", secretName: croweSecretName,
			stored: "fictional-stored", exists: true, storeErr: storeErr, runtime: "fictional-runtime",
			wantError: "failed to retrieve secret CROWE_MODELS_KEY: fictional store unavailable", wantStoreCalls: 1,
		},
		{
			name: "unrelated store error preserved", secretName: "OTHER_API_KEY", storeErr: storeErr, runtime: "fictional-runtime",
			wantError: "failed to retrieve secret OTHER_API_KEY: fictional store unavailable", wantStoreCalls: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			storeCalls, runtimeCalls := 0, 0
			getSecret := func(name string) (string, bool, error) {
				storeCalls++
				if name != tt.secretName {
					t.Fatal("store received unexpected secret name")
				}
				return tt.stored, tt.exists, tt.storeErr
			}
			getRuntimeKey := func(name string) string {
				runtimeCalls++
				if name != croweSecretName {
					t.Fatal("runtime fallback received unrelated secret name")
				}
				return tt.runtime
			}
			got, err := resolveAPIToken(tt.apiToken, tt.secretName, croweSecretName, getSecret, getRuntimeKey)
			if got != tt.want {
				t.Error("resolved token did not match expected value")
			}
			if tt.wantError == "" {
				if err != nil {
					t.Error("unexpected authentication error")
				}
			} else {
				if err == nil {
					t.Fatal("expected authentication error")
				}
				if err.Error() != tt.wantError {
					t.Error("authentication error text did not match expected guidance")
				}
				if got != "" {
					t.Error("authentication failure returned a token")
				}
				if tt.storeErr != nil && !errors.Is(err, tt.storeErr) {
					t.Error("store error was not wrapped")
				}
				for _, token := range []string{"fictional-explicit", "fictional-stored", "fictional-runtime"} {
					if strings.Contains(err.Error(), token) {
						t.Error("authentication error disclosed a fictional token")
					}
				}
			}
			if storeCalls != tt.wantStoreCalls || runtimeCalls != tt.wantRuntimeCalls {
				t.Errorf("getter calls: store=%d runtime=%d; want store=%d runtime=%d", storeCalls, runtimeCalls, tt.wantStoreCalls, tt.wantRuntimeCalls)
			}
		})
	}
}

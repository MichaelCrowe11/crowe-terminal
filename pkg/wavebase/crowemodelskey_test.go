// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"os"
	"testing"
)

func TestCroweModelsKeyForRuntime(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "empty"},
		{name: "whitespace", value: " \t\r\n "},
		{name: "fictional key", value: "fictional-runtime-one", want: "fictional-runtime-one"},
		{name: "trimmed key", value: " \tfictional-runtime-two\n ", want: "fictional-runtime-two"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(CroweModelsKeyEnvVar, tt.value)
			if CroweModelsKeyFor(CroweModelsSecretName) != tt.want {
				t.Fatal("runtime key did not match expected value")
			}
		})
	}
}

func TestCroweModelsKeyForUnsetRuntime(t *testing.T) {
	t.Setenv(CroweModelsKeyEnvVar, "")
	if err := os.Unsetenv(CroweModelsKeyEnvVar); err != nil {
		t.Fatal("could not unset fictional runtime environment")
	}
	if CroweModelsKeyFor(CroweModelsSecretName) != "" {
		t.Fatal("unset environment must not provide a credential")
	}
}

func TestCroweModelsKeyForScope(t *testing.T) {
	t.Setenv(CroweModelsKeyEnvVar, "fictional-runtime-scoped")
	for _, name := range []string{"", "OTHER_API_KEY", "crowe_models_key", " CROWE_MODELS_KEY", "CROWE_MODELS_KEY "} {
		t.Run(name, func(t *testing.T) {
			if CroweModelsKeyFor(name) != "" {
				t.Fatal("runtime credential escaped its exact secret-name scope")
			}
		})
	}
}

func TestCroweModelsKeyForReadsRuntimeEachCall(t *testing.T) {
	t.Setenv(CroweModelsKeyEnvVar, "fictional-runtime-first")
	if CroweModelsKeyFor(CroweModelsSecretName) != "fictional-runtime-first" {
		t.Fatal("initial runtime value was not used")
	}
	t.Setenv(CroweModelsKeyEnvVar, "fictional-runtime-second")
	if CroweModelsKeyFor(CroweModelsSecretName) != "fictional-runtime-second" {
		t.Fatal("updated runtime value was not used")
	}
	t.Setenv(CroweModelsKeyEnvVar, "")
	if CroweModelsKeyFor(CroweModelsSecretName) != "" {
		t.Fatal("cleared runtime value must not retain a credential")
	}
}

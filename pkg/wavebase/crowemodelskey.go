// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"os"
	"strings"
)

const (
	CroweModelsSecretName = "CROWE_MODELS_KEY"
	CroweModelsKeyEnvVar  = "HYPHEUS_MODELS_KEY"
)

// CroweModelsKeyFor limits the runtime fallback to the CroweLM secret name;
// unrelated providers must not receive the Crowe credential.
func CroweModelsKeyFor(secretName string) string {
	if secretName != CroweModelsSecretName {
		return ""
	}
	return strings.TrimSpace(os.Getenv(CroweModelsKeyEnvVar))
}

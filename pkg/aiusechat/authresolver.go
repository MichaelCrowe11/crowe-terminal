// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/croweauth"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func validateAccountConfig(config wconfig.AIModeConfigType) error {
	if config.APIType != uctypes.APIType_CroweGateway || !croweauth.IsGatewayEndpoint(config.Endpoint) {
		return fmt.Errorf("Crowe account requests must use the trusted account gateway")
	}
	if config.ProxyURL != "" || config.APIToken != "" || config.APITokenSecretName != "" {
		return fmt.Errorf("Crowe account mode cannot use a proxy or a separate API key")
	}
	return nil
}

func resolveAPIToken(apiToken, secretName, croweSecretName string, getSecret func(string) (string, bool, error), getRuntimeKey func(string) string) (string, error) {
	if apiToken != "" || secretName == "" {
		return apiToken, nil
	}
	secret, exists, err := getSecret(secretName)
	if err != nil {
		return "", fmt.Errorf("failed to retrieve secret %s: %w", secretName, err)
	}
	secret = strings.TrimSpace(secret)
	if exists && secret != "" {
		return secret, nil
	}
	if secretName != croweSecretName {
		return "", fmt.Errorf("secret %s not found or empty", secretName)
	}
	if runtimeKey := getRuntimeKey(secretName); runtimeKey != "" {
		return runtimeKey, nil
	}
	return "", fmt.Errorf("Crowe Logic model authentication is not configured. Add a %s secret in Settings > Secrets > Add New Secret, or run wsh secret ui", secretName)
}

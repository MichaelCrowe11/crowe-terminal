// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

var authkey string

const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY"
const AuthKeyHeader = "X-AuthKey"
const sharedKeyFileName = "agent-authkey"

func ValidateIncomingRequest(r *http.Request) error {
	reqAuthKey := r.Header.Get(AuthKeyHeader)
	if reqAuthKey == "" {
		return fmt.Errorf("no x-authkey header")
	}
	if reqAuthKey != GetAuthKey() {
		return fmt.Errorf("x-authkey header is invalid")
	}
	return nil
}

func SetAuthKeyFromEnv() error {
	authkey = os.Getenv(WaveAuthKeyEnv)
	if authkey == "" {
		return fmt.Errorf("no auth key found in environment variables")
	}
	os.Unsetenv(WaveAuthKeyEnv)
	return nil
}

func GetAuthKey() string {
	return authkey
}

func sharedKeyFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".crowe-logic", sharedKeyFileName), nil
}

// WriteSharedKeyFile persists the in-memory auth key to ~/.crowe-logic/agent-authkey
// (0600) so out-of-process Crowe Logic surfaces (Foundry, Cortex) can authenticate to
// the loopback agent transport without inheriting WAVETERM_AUTH_KEY from the environment.
func WriteSharedKeyFile() error {
	if authkey == "" {
		return fmt.Errorf("auth key not set; call SetAuthKeyFromEnv first")
	}
	path, err := sharedKeyFilePath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create shared key dir %q: %w", dir, err)
	}
	if err := os.WriteFile(path, []byte(authkey), 0o600); err != nil {
		return fmt.Errorf("write shared key file %q: %w", path, err)
	}
	return nil
}

func RemoveSharedKeyFile() error {
	path, err := sharedKeyFilePath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove shared key file %q: %w", path, err)
	}
	return nil
}

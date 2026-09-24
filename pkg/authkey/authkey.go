// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
)

const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY"
const AuthKeyHeader = "X-AuthKey"
const frontendKeyEnv = "WAVETERM_FRONTEND_KEY"
const frontendKeyHeader = "X-Wave-Frontend-Key"

var authkey string
var frontendKey string

func IsLocalFrontendRequest(r *http.Request) bool {
	values := r.Header.Values(frontendKeyHeader)
	return frontendKey != "" && len(values) == 1 && subtle.ConstantTimeCompare([]byte(values[0]), []byte(frontendKey)) == 1
}

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
	frontendKey = os.Getenv(frontendKeyEnv)
	os.Unsetenv(frontendKeyEnv)
	os.Unsetenv(WaveAuthKeyEnv)
	if authkey == "" {
		return fmt.Errorf("no auth key found in environment variables")
	}
	return nil
}

func GetAuthKey() string {
	return authkey
}

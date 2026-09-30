// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxResponseBytes = 64 * 1024

type deviceResponse struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int64  `json:"expires_in"`
	Interval        int64  `json:"interval"`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
}

type oauthError struct{ code string }

func (e *oauthError) Error() string { return "Crowe authorization was not completed" }

func isOAuthError(err error, code string) bool {
	var oauth *oauthError
	return errors.As(err, &oauth) && oauth.code == code
}

func safeError(err error) error {
	if errors.Is(err, ErrSignInRequired) || isOAuthError(err, "invalid_grant") {
		return ErrSignInRequired
	}
	if errors.Is(err, errStorage) {
		return errStorage
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	if errors.Is(err, errResponse) {
		return errResponse
	}
	return errRequest
}

func (m *Manager) post(ctx context.Context, path string, values url.Values, result any) error {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, Issuer+"/protocol/openid-connect"+path, strings.NewReader(values.Encode()))
	if err != nil {
		return errRequest
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errRequest
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return errResponse
	}
	if requestCtx.Err() != nil {
		return requestCtx.Err()
	}
	if resp.StatusCode != http.StatusOK {
		var payload struct {
			Error string `json:"error"`
		}
		if (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized) && json.Unmarshal(body, &payload) == nil {
			switch payload.Error {
			case "authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_grant":
				return &oauthError{code: payload.Error}
			}
		}
		return errRequest
	}
	if err := json.Unmarshal(body, result); err != nil {
		return errResponse
	}
	return nil
}

func validDevice(result deviceResponse) bool {
	if result.DeviceCode == "" || len(result.DeviceCode) > 8192 || result.UserCode == "" || len(result.UserCode) > 128 || result.ExpiresIn <= 0 || result.ExpiresIn > 3600 || result.Interval < 0 || result.Interval > 3600 {
		return false
	}
	for _, c := range result.UserCode {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	// Only the issuer's verification page may reach the browser; never expose a query carrying secrets.
	return result.VerificationURI == Issuer+"/device"
}

func validToken(result tokenResponse) bool {
	return result.AccessToken != "" && result.RefreshToken != "" &&
		strings.EqualFold(result.TokenType, "Bearer") && result.ExpiresIn > 0 && result.ExpiresIn <= 7*24*3600 &&
		!strings.ContainsAny(result.AccessToken, "\r\n\x00") && !strings.ContainsAny(result.RefreshToken, "\r\n\x00")
}

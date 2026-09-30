// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/croweauth"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestCroweAuthCommandsRequireFrontendContext(t *testing.T) {
	server := &WshServer{}
	commands := map[string]func(context.Context) (*wshrpc.CroweAuthStatus, error){
		"status":     server.CroweAuthStatusCommand,
		"start":      server.CroweAuthStartCommand,
		"cancel":     server.CroweAuthCancelCommand,
		"disconnect": server.CroweAuthDisconnectCommand,
	}
	for name, command := range commands {
		t.Run(name, func(t *testing.T) {
			status, err := command(context.Background())
			if err == nil || status != nil {
				t.Fatalf("missing context returned status=%v error=%v", status, err)
			}
		})
	}
}

func TestCroweAuthResponseFields(t *testing.T) {
	status := croweauth.Status{
		State:           "pending",
		UserCode:        "TEST-CODE",
		VerificationURL: "https://example.test/activate",
		ExpiresAt:       1790000000000,
		Message:         "Finish signing in in your browser.",
	}
	response, err := croweAuthResponse(status, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"state":           status.State,
		"usercode":        status.UserCode,
		"verificationurl": status.VerificationURL,
		"expiresat":       float64(status.ExpiresAt),
		"message":         status.Message,
	}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("response fields = %v, want %v", fields, want)
	}
}

func TestCroweAuthResponseRedactsErrors(t *testing.T) {
	marker := "fake-sensitive-provider-response"
	messages := []string{
		marker,
		croweAuthStorageUnavailable + marker,
		marker + croweAuthDisconnectWarning,
		strings.ToLower(croweAuthStorageUnavailable),
		croweAuthDisconnectWarning + " ",
	}
	for _, message := range messages {
		response, err := croweAuthResponse(croweauth.Status{Message: message}, errors.New(marker))
		if response != nil || err == nil || strings.Contains(err.Error(), marker) {
			t.Fatalf("provider failure was not safely redacted")
		}
	}
}

func TestCroweAuthResponsePreservesSafeOperationalWarnings(t *testing.T) {
	marker := "fake-sensitive-provider-response"
	cases := []struct {
		message string
		state   string
	}{
		{croweAuthStorageUnavailable, croweauth.StateError},
		{croweAuthDisconnectWarning, croweauth.StateSignedOut},
	}
	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			status := croweauth.Status{
				State:           marker,
				UserCode:        marker,
				VerificationURL: marker,
				ExpiresAt:       1790000000000,
				Message:         tc.message,
			}
			response, err := croweAuthResponse(status, errors.New(marker))
			if err != nil {
				t.Fatal("safe operational warning was discarded")
			}
			want := &wshrpc.CroweAuthStatus{State: tc.state, Message: tc.message}
			if !reflect.DeepEqual(response, want) {
				t.Fatal("operational warning included unapproved status fields")
			}
			encoded, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), marker) {
				t.Fatal("operational warning exposed a sensitive field")
			}
		})
	}
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpuidemo

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestEchoToolReturnsParams(t *testing.T) {
	res, err := handleEcho(context.Background(), json.RawMessage(`{"msg":"hi"}`))
	if err != nil {
		t.Fatalf("handleEcho returned error: %v", err)
	}
	if res.IsError {
		t.Fatalf("handleEcho returned an error result: %s", res.ErrorText)
	}
	if !strings.Contains(string(res.Content), "hi") {
		t.Fatalf("echo content did not contain the sent param: %s", string(res.Content))
	}
}

func TestShowToolHTMLWellFormed(t *testing.T) {
	required := []string{
		"ui-lifecycle-iframe-ready",
		`"mcpui.demo.echo"`,
		`type: "link"`,
		`type: "notify"`,
		"window.parent.postMessage",
	}
	for _, want := range required {
		if !strings.Contains(demoHTML, want) {
			t.Errorf("demoHTML missing required protocol bit: %q", want)
		}
	}
}

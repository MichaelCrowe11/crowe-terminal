// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpproxy

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestHandleResultRendersUIResource(t *testing.T) {
	var rendered *mcpui.UIResource
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		rendered = ui
		return "Surfaced interactive UI from " + tool, nil
	}
	defer func() { renderUI = prev }()

	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "resource", Resource: &mcpclient.EmbeddedResource{
			URI: "ui://w/1", MimeType: "text/html", Text: "<h1>hi</h1>"}},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("unexpected error: %s", out.ErrorText)
	}
	if rendered == nil || rendered.HTML != "<h1>hi</h1>" {
		t.Fatalf("renderer not called with resource: %+v", rendered)
	}
	var got string
	_ = json.Unmarshal(out.Content, &got)
	if got != "Surfaced interactive UI from demo.tool" {
		t.Fatalf("bad summary content: %s", out.Content)
	}
}

func TestHandleResultFallsBackToTextOnNoUI(t *testing.T) {
	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "text", Text: "plain"},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("unexpected error: %s", out.ErrorText)
	}
	var decoded mcpclient.CallResult
	if err := json.Unmarshal(out.Content, &decoded); err != nil {
		t.Fatalf("expected marshalled CallResult, got %s", out.Content)
	}
	if decoded.Content[0].Text != "plain" {
		t.Fatalf("bad fallback content: %s", out.Content)
	}
}

func TestHandleResultFallsBackWhenRenderFails(t *testing.T) {
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		return "", context.Canceled
	}
	defer func() { renderUI = prev }()

	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "resource", Resource: &mcpclient.EmbeddedResource{
			URI: "ui://w/1", MimeType: "text/html", Text: "<h1>hi</h1>"}},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("render failure must not error the tool call: %s", out.ErrorText)
	}
	var decoded mcpclient.CallResult
	if err := json.Unmarshal(out.Content, &decoded); err != nil {
		t.Fatalf("expected text fallback (marshalled CallResult), got %s", out.Content)
	}
}

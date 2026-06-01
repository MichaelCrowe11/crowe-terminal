// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpproxy

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestE2EUIResourceTriggersRender(t *testing.T) {
	bin := t.TempDir() + "/ui-echo-server"
	if out, err := exec.Command("go", "build", "-o", bin,
		"github.com/wavetermdev/waveterm/pkg/mcpui/testdata/ui-echo-server").CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, out)
	}

	var renderedHTML string
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		renderedHTML = ui.HTML
		return "rendered " + tool, nil
	}
	defer func() { renderUI = prev }()

	m := &Mount{EnableEnv: "MCPUI_E2E", Namespace: "echo.", Command: bin}
	t.Setenv("MCPUI_E2E", "1")
	if n := Activate(m); n != 1 {
		t.Fatalf("want 1 tool registered, got %d", n)
	}

	res, err := m.makeHandler("echo_ui")(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("handler err: %v", err)
	}
	if res.IsError {
		t.Fatalf("handler returned error: %s", res.ErrorText)
	}
	if renderedHTML != "<button>hi</button>" {
		t.Fatalf("render hook not invoked with UI html, got %q", renderedHTML)
	}
}

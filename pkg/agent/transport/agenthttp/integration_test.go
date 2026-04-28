// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package agenthttp_test

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/allowlist"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/system"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"
	"github.com/wavetermdev/waveterm/pkg/authkey"
)

const testKey = "integration-test-key"

func TestEndToEnd(t *testing.T) {
	os.Setenv("WAVETERM_AUTH_KEY", testKey)
	if err := authkey.SetAuthKeyFromEnv(); err != nil {
		t.Fatalf("setauth: %v", err)
	}
	os.Setenv("CROWE_AGENT_PORT", "18012")
	os.Unsetenv("CROWE_AGENT_DISABLED")

	agent.InitAgent(context.Background())
	if agent.Server == nil {
		t.Fatal("agent did not start")
	}
	defer agent.Server.Stop(context.Background())
	time.Sleep(150 * time.Millisecond)

	base := "http://127.0.0.1:18012"

	// 1) reject unauthenticated
	resp, err := http.Get(base + "/v1/tools")
	if err != nil {
		t.Fatalf("unauth GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 unauth, got %d", resp.StatusCode)
	}

	// 2) catalog includes core tools
	body := authedGet(t, base+"/v1/tools")
	for _, name := range []string{"system.metrics", "terminal.exec_safe",
		"allowlist.check", "allowlist.list", "allowlist.add"} {
		if !strings.Contains(body, name) {
			t.Errorf("catalog missing %s", name)
		}
	}

	// 3) call system.metrics
	body = authedPost(t, base+"/v1/call",
		`{"name":"system.metrics","arguments":{"topn":1}}`)
	if !strings.Contains(body, "cpu_percent") {
		t.Errorf("metrics missing cpu_percent: %s", truncate(body))
	}

	// 4) refuse mutating exec
	body = authedPost(t, base+"/v1/call",
		`{"name":"terminal.exec_safe","arguments":{"command":"rm -rf /tmp/x"}}`)
	if !strings.Contains(body, "iserror") {
		t.Errorf("expected iserror on mutating: %s", truncate(body))
	}

	// 5) allow safe exec
	body = authedPost(t, base+"/v1/call",
		`{"name":"terminal.exec_safe","arguments":{"command":"echo hello-from-agent"}}`)
	if !strings.Contains(body, "hello-from-agent") {
		t.Errorf("expected echo output: %s", truncate(body))
	}

	// 6) allowlist.check returns true for default
	body = authedPost(t, base+"/v1/call",
		`{"name":"allowlist.check","arguments":{"kind":"command","candidate":"git status"}}`)
	if !strings.Contains(body, `"allowed":true`) {
		t.Errorf("expected allowlist allowed=true: %s", truncate(body))
	}

	// 7) loopback-only protection: server rejects non-loopback origin
	// (we can't easily simulate a non-loopback request from within the
	// test process without spoofing, so this is exercised by inspection.)
}

func authedGet(t *testing.T, url string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-AuthKey", testKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status: %d", url, resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func authedPost(t *testing.T, url, body string) string {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("X-AuthKey", testKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s status: %d", url, resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200] + "...(truncated)"
	}
	return s
}

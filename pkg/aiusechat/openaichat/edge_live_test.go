// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package openaichat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/aiutil"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wconfig/defaultconfig"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

// Opt-in end-to-end check of the shipped CroweLM modes against the live model
// edge, through the same request builder and stream parser the app uses.
//
//	HYPHEUS_EDGE_LIVE=1 HYPHEUS_MODELS_KEY=... go test ./pkg/aiusechat/openaichat/ -run TestEdgeLive -v
func TestEdgeLiveShippedCroweLMModes(t *testing.T) {
	if os.Getenv("HYPHEUS_EDGE_LIVE") == "" {
		t.Skip("set HYPHEUS_EDGE_LIVE=1 to run against models.crowelogic.com")
	}
	key := wavebase.CroweModelsKeyFor(wavebase.CroweModelsSecretName)
	if key == "" {
		t.Skipf("set %s to run the live edge test", wavebase.CroweModelsKeyEnvVar)
	}
	raw, err := defaultconfig.ConfigFS.ReadFile("waveai.json")
	if err != nil {
		t.Fatalf("read defaults waveai.json: %v", err)
	}
	var modes map[string]wconfig.AIModeConfigType
	if err := json.Unmarshal(raw, &modes); err != nil {
		t.Fatalf("parse waveai.json: %v", err)
	}
	for _, name := range []string{"waveai@crowelm-auto", "waveai@crowelm-apex", "waveai@crowelm-supreme", "waveai@crowelm-grower", "waveai@crowelm-kernel"} {
		mode, ok := modes[name]
		if !ok {
			t.Fatalf("%s missing from shipped defaults", name)
		}
		t.Run(name, func(t *testing.T) {
			runEdgeRoundTrip(t, mode, key)
		})
	}
}

// httptest.ResponseRecorder has no write deadline, which SetupSSE requires
// through http.ResponseController; a no-op satisfies it for a test.
type deadlineRecorder struct {
	*httptest.ResponseRecorder
}

func (deadlineRecorder) SetWriteDeadline(time.Time) error {
	return nil
}

func runEdgeRoundTrip(t *testing.T, mode wconfig.AIModeConfigType, key string) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	chatOpts := uctypes.WaveChatOpts{
		ChatId: "edge-live",
		Config: uctypes.AIOptsType{
			Provider:     mode.Provider,
			APIType:      mode.APIType,
			Model:        mode.Model,
			Endpoint:     mode.Endpoint,
			APIToken:     key,
			MaxTokens:    200,
			TimeoutMs:    110000,
			Capabilities: mode.Capabilities,
			SystemPrompt: mode.SystemPrompt,
		},
		SystemPrompt: []string{"Reply with exactly the word OK and nothing else."},
	}
	if mode.SystemPrompt != "" {
		chatOpts.SystemPrompt = append(chatOpts.SystemPrompt, mode.SystemPrompt)
	}
	messages := []ChatRequestMessage{{Role: "user", Content: "Say OK"}}
	req, err := buildChatHTTPRequest(ctx, messages, chatOpts)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if got := req.URL.String(); got != mode.Endpoint {
		t.Fatalf("request url %q, want %q", got, mode.Endpoint)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer "+key {
		t.Fatalf("authorization header not the bearer key")
	}
	client, err := aiutil.MakeHTTPClient("")
	if err != nil {
		t.Fatalf("http client: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("edge call: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("edge returned %d: %s", resp.StatusCode, string(body))
	}
	handler := sse.MakeSSEHandlerCh(deadlineRecorder{httptest.NewRecorder()}, ctx)
	if err := handler.SetupSSE(); err != nil {
		t.Fatalf("sse setup: %v", err)
	}
	stop, assistant, err := processChatStream(ctx, resp.Body, handler, chatOpts, nil)
	if err != nil {
		t.Fatalf("stream parse: %v", err)
	}
	if assistant == nil {
		t.Fatalf("no assistant message parsed (stop=%+v)", stop)
	}
	text := strings.TrimSpace(assistant.Message.Content)
	if !strings.Contains(strings.ToUpper(text), "OK") {
		t.Fatalf("model %s replied %q, expected OK", mode.Model, text)
	}
	t.Logf("%s -> %s: %q (stop=%s)", mode.DisplayName, mode.Model, text, stop.Kind)
}

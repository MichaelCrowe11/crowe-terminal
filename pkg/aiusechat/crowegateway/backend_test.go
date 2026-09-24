// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package crowegateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/chatstore"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/openaichat"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

const TestToken = "synthetic-test-access-token"
const TestModels = `{"plan":"free","default_model":"crowelm-flash","models":[{"model":"crowelm-flash","name":"CroweLM Flash","min_plan":"free","group":"crowelm"}]}`
const TestResponse = `{"id":"gateway-response","model":"crowelm-flash","content":"Hello 世界","usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16},"latency_ms":50,"tool_calls":null}`

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

type streamRecorder struct{ *httptest.ResponseRecorder }

func (*streamRecorder) SetWriteDeadline(time.Time) error { return nil }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func makeChat(t *testing.T) uctypes.WaveChatOpts {
	t.Helper()
	opts := uctypes.WaveChatOpts{
		ChatId: uuid.NewString(),
		Config: uctypes.AIOptsType{Model: AccountDefaultModel, APIToken: TestToken, APIType: "crowe-gateway", Capabilities: []string{uctypes.AICapabilityTools}},
	}
	msg := &openaichat.StoredChatMessage{MessageId: uuid.NewString(), Message: openaichat.ChatRequestMessage{Role: "user", Content: "hello"}}
	if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { chatstore.DefaultChatStore.Delete(opts.ChatId) })
	return opts
}

func makeHandler(t *testing.T) (*sse.SSEHandlerCh, *streamRecorder) {
	t.Helper()
	recorder := &streamRecorder{httptest.NewRecorder()}
	handler := sse.MakeSSEHandlerCh(recorder, context.Background())
	t.Cleanup(handler.Close)
	return handler, recorder
}

func eventTypes(t *testing.T, recorder *streamRecorder) []string {
	t.Helper()
	var types []string
	for _, line := range strings.Split(recorder.Body.String(), "\n") {
		if !strings.HasPrefix(line, "data: ") || line == "data: [DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatalf("invalid SSE frame: %v", err)
		}
		types = append(types, event["type"].(string))
	}
	return types
}

func TestTextResponseLifecycle(t *testing.T) {
	opts := makeChat(t)
	opts.SystemPrompt = []string{"system one", "system two"}
	opts.TabState = "tab context"
	opts.PlatformInfo = "test platform"
	opts.Config.MaxTokens = 512
	calls := 0
	backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.Header.Get("Authorization") != "Bearer "+TestToken {
			t.Fatal("missing bearer")
		}
		if req.Header.Get("Accept") != "application/json" {
			t.Fatal("stream requested upstream")
		}
		if req.URL.String() == ModelsEndpoint {
			return response(200, TestModels), nil
		}
		if req.URL.String() != GatewayEndpoint || req.Method != http.MethodPost {
			t.Fatal("unexpected endpoint")
		}
		data, _ := io.ReadAll(req.Body)
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["model"] != "crowelm-flash" || payload["max_tokens"] != float64(512) {
			t.Fatalf("bad selection/options: %v", payload)
		}
		for _, key := range []string{"stream", "max_completion_tokens", "apitoken"} {
			if _, exists := payload[key]; exists {
				t.Fatalf("unexpected %s", key)
			}
		}
		messages := payload["messages"].([]any)
		if len(messages) != 2 || messages[0].(map[string]any)["content"] != "system one\n\nsystem two" {
			t.Fatal("missing system prompt")
		}
		if messages[1].(map[string]any)["content"] != "hello\n\ntab context\n\n<PlatformInfo>\ntest platform\n</PlatformInfo>" {
			t.Fatal("missing contextual prompt")
		}
		return response(200, TestResponse), nil
	})}
	handler, recorder := makeHandler(t)
	stop, messages, limit, err := backend.RunChatStep(context.Background(), handler, opts, nil)
	handler.Close()
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || stop.Kind != uctypes.StopKindDone || len(messages) != 1 || limit != nil {
		t.Fatalf("bad result: %+v", stop)
	}
	msg := messages[0].(*openaichat.StoredChatMessage)
	if msg.Message.Content != "Hello 世界" || msg.GetUsage().InputTokens != 12 || msg.GetUsage().OutputTokens != 4 {
		t.Fatalf("lost text/usage: %+v", msg)
	}
	want := []string{"start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"}
	if got := eventTypes(t, recorder); !reflect.DeepEqual(got, want) {
		t.Fatalf("events %v != %v", got, want)
	}
	if strings.Contains(recorder.Body.String(), TestToken) {
		t.Fatal("credential in SSE")
	}
	stored := chatstore.DefaultChatStore.Get(opts.ChatId).NativeMessages[0].(*openaichat.StoredChatMessage)
	if stored.Message.Content != "hello" {
		t.Fatal("mutated history")
	}
}

func TestToolRoundTrip(t *testing.T) {
	opts := makeChat(t)
	opts.Tools = []uctypes.ToolDefinition{{Name: "read_file", Description: "Read", InputSchema: map[string]any{"type": "object"}}}
	opts.TabTools = []uctypes.ToolDefinition{{Name: "blocked", RequiredCapabilities: []string{"unavailable"}}}
	posts := 0
	backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == http.MethodGet {
			return response(200, TestModels), nil
		}
		posts++
		data, _ := io.ReadAll(req.Body)
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload["tools"].([]any)) != 1 {
			t.Fatal("capability filter missing")
		}
		if strings.Contains(string(data), "toolusedata") || strings.Contains(string(data), "approval") {
			t.Fatal("internal tool metadata leaked")
		}
		if posts == 1 {
			return response(200, `{"id":"tool-step","model":"crowelm-flash","content":"Checking now","usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3},"tool_calls":[{"id":"call-one","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"test.txt\"}"}}]}`), nil
		}
		messages := payload["messages"].([]any)
		if len(messages) != 3 {
			t.Fatalf("history size %d", len(messages))
		}
		assistant := messages[1].(map[string]any)
		if assistant["role"] != "assistant" || assistant["content"] != "Checking now" || len(assistant["tool_calls"].([]any)) != 1 {
			t.Fatal("assistant tool history lost")
		}
		tool := messages[2].(map[string]any)
		if tool["role"] != "tool" || tool["tool_call_id"] != "call-one" || tool["name"] != "read_file" || tool["content"] != "file data" {
			t.Fatal("tool result incorrect")
		}
		return response(200, TestResponse), nil
	})}
	handler, recorder := makeHandler(t)
	stop, messages, _, err := backend.RunChatStep(context.Background(), handler, opts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if stop.Kind != uctypes.StopKindToolUse || len(stop.ToolCalls) != 1 || stop.ToolCalls[0].Input.(map[string]any)["path"] != "test.txt" {
		t.Fatalf("tool call not decoded: %+v", stop)
	}
	for _, msg := range messages {
		if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
			t.Fatal(err)
		}
	}
	if err := backend.UpdateToolUseData(opts.ChatId, "call-one", uctypes.UIMessageDataToolUse{ToolCallId: "call-one", ToolName: "read_file", Approval: uctypes.ApprovalUserApproved}); err != nil {
		t.Fatal(err)
	}
	chat := chatstore.DefaultChatStore.Get(opts.ChatId)
	if backend.GetFunctionCallInputByToolCallId(*chat, "call-one").ToolUseData == nil {
		t.Fatal("tool metadata not persisted")
	}
	ui, err := backend.ConvertAIChatToUIChat(*chat)
	if err != nil || len(ui.Messages) != 2 {
		t.Fatal("UI conversion failed")
	}
	results, err := backend.ConvertToolResultsToNativeChatMessage([]uctypes.AIToolResult{{ToolName: "read_file", ToolUseID: "call-one", Text: "file data"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range results {
		if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
			t.Fatal(err)
		}
	}
	stop, _, _, err = backend.RunChatStep(context.Background(), handler, opts, &uctypes.WaveContinueResponse{ContinueFromKind: uctypes.StopKindToolUse})
	handler.Close()
	if err != nil || stop.Kind != uctypes.StopKindDone || posts != 2 {
		t.Fatalf("continuation failed: %v", err)
	}
	want := []string{"start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"}
	if got := eventTypes(t, recorder); !reflect.DeepEqual(got, want) {
		t.Fatalf("events %v != %v", got, want)
	}
}

func TestMalformedResponseRejectedBeforeSSE(t *testing.T) {
	for _, body := range []string{
		`{`, `null`, `{}`, TestResponse + `{}`, `{"choices":[{"message":{"content":"wrong API"}}]}`,
		strings.Replace(TestResponse, `"prompt_tokens":12`, `"prompt_tokens":-1`, 1),
		strings.Replace(TestResponse, `"Hello 世界"`, `42`, 1),
		strings.Replace(TestResponse, `"Hello 世界"`, `""`, 1),
		strings.Replace(TestResponse, `"id":"gateway-response"`, `"id":""`, 1),
		strings.Replace(TestResponse, `"latency_ms":50`, `"latency_ms":-1`, 1),
	} {
		t.Run(fmt.Sprintf("case-%d", len(body)), func(t *testing.T) {
			opts := makeChat(t)
			backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method == http.MethodGet {
					return response(200, TestModels), nil
				}
				return response(200, body), nil
			})}
			handler, recorder := makeHandler(t)
			_, msgs, _, err := backend.RunChatStep(context.Background(), handler, opts, nil)
			if !errors.Is(err, ErrInvalidResponse) || len(msgs) != 0 || recorder.Body.Len() != 0 {
				t.Fatalf("accepted invalid response: %v", err)
			}
		})
	}
}

func TestInvalidToolCalls(t *testing.T) {
	req := &chatRequest{Tools: []openaichat.ToolDefinition{{Type: "function", Function: openaichat.ToolFunctionDef{Name: "allowed"}}}}
	valid := toolCall{ID: "one", Type: "function", Function: openaichat.ToolFunctionCall{Name: "allowed", Arguments: `{"n":1}`}}
	for _, argument := range []string{"", "null", "[]", "42", `{`, `{} {}`} {
		call := valid
		call.Function.Arguments = argument
		resp := &chatResponse{ID: "response", Model: "model", Usage: &openaichat.ChatUsage{}, ToolCalls: []toolCall{call}}
		if _, err := validateResponse(resp, req); !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("accepted args %q", argument)
		}
	}
	for _, calls := range [][]toolCall{
		{valid, valid},
		{{ID: "", Type: "function", Function: valid.Function}},
		{{ID: "one", Type: "other", Function: valid.Function}},
		{{ID: "one", Type: "function", Function: openaichat.ToolFunctionCall{Name: "unoffered", Arguments: `{}`}}},
	} {
		if _, err := validateResponse(&chatResponse{ID: "response", Model: "model", Usage: &openaichat.ChatUsage{}, ToolCalls: calls}, req); !errors.Is(err, ErrInvalidResponse) {
			t.Fatal("accepted malformed calls")
		}
	}
	resp := &chatResponse{ID: "response", Model: "model", Usage: &openaichat.ChatUsage{}, ToolCalls: []toolCall{valid}}
	if calls, err := validateResponse(resp, req); err != nil || len(calls) != 1 {
		t.Fatalf("tool-only response rejected: %v", err)
	}
	req.Messages = []requestMessage{{Role: "assistant", ToolCalls: []toolCall{valid}}}
	if _, err := validateResponse(resp, req); !errors.Is(err, ErrInvalidResponse) {
		t.Fatal("accepted stale call id")
	}
}

func TestHTTPFailuresAreSafe(t *testing.T) {
	tests := []struct {
		status int
		body   string
		want   error
	}{
		{401, TestToken, ErrSignInRequired},
		{402, `{"detail":{"code":"free_daily_cap","message":"` + TestToken + `"}}`, ErrFreeDailyCap},
		{402, TestToken, ErrQuota}, {403, TestToken, ErrPlan}, {410, TestToken, ErrModelRetired},
		{429, TestToken, ErrRateLimit}, {500, TestToken, ErrGateway}, {302, TestToken, ErrRedirect},
		{200, TestToken, ErrInvalidResponse}, {200, strings.Repeat("x", MaxResponseBytes+1), ErrResponseTooLarge},
	}
	for _, test := range tests {
		t.Run(fmt.Sprint(test.status), func(t *testing.T) {
			calls := 0
			backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				resp := response(test.status, test.body)
				resp.Header.Set("Location", "https://attacker.invalid/?token="+TestToken)
				return resp, nil
			})}
			_, err := backend.FetchModels(context.Background(), TestToken)
			if !errors.Is(err, test.want) || strings.Contains(err.Error(), TestToken) || calls != 1 {
				t.Fatalf("unsafe failure: %v (%d calls)", err, calls)
			}
		})
	}
	backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("transport leaked " + TestToken)
	})}
	if _, err := backend.FetchModels(context.Background(), TestToken); !errors.Is(err, ErrGateway) || strings.Contains(err.Error(), TestToken) {
		t.Fatal("raw transport error returned")
	}
}

func TestModelSelection(t *testing.T) {
	for _, test := range []struct {
		body, selection, want string
		fail                  error
	}{
		{TestModels, AccountDefaultModel, "crowelm-flash", nil},
		{TestModels, "", "crowelm-flash", nil},
		{TestModels, "crowelm-flash", "crowelm-flash", nil},
		{TestModels, "crowelm-zenith", "", ErrModelUnavailable},
		{`{"plan":"paid","default_model":"crowelm","models":[{"model":"crowelm"}]}`, AccountDefaultModel, "crowelm", nil},
		{`{"plan":"free","default_model":"crowelm-flash","models":[{"id":"crowelm-flash"}]}`, AccountDefaultModel, "", ErrInvalidResponse},
		{`{"plan":"free","default_model":"missing","models":[{"model":"crowelm-flash"}]}`, AccountDefaultModel, "", ErrInvalidResponse},
		{`{"plan":"free","default_model":"x","models":[{"model":"x"},{"model":"x"}]}`, AccountDefaultModel, "", ErrInvalidResponse},
	} {
		var models ModelsResponse
		if err := json.Unmarshal([]byte(test.body), &models); err != nil {
			t.Fatal(err)
		}
		got, err := models.SelectModel(test.selection)
		if got != test.want || !errors.Is(err, test.fail) {
			t.Fatalf("selection %q: %q %v", test.selection, got, err)
		}
	}
	opts := makeChat(t)
	opts.Config.Model = "unavailable"
	posts := 0
	backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == http.MethodPost {
			posts++
		}
		return response(200, TestModels), nil
	})}
	handler, _ := makeHandler(t)
	if _, _, _, err := backend.RunChatStep(context.Background(), handler, opts, nil); !errors.Is(err, ErrModelUnavailable) || posts != 0 {
		t.Fatalf("silently sent unavailable model: %v", err)
	}
}

func TestTokenAndEndpointValidation(t *testing.T) {
	calls := 0
	backend := &Backend{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { calls++; return response(200, TestModels), nil })}
	for _, token := range []string{"", "secret\r\ninjected: header", "invalid token"} {
		if _, err := backend.FetchModels(context.Background(), token); !errors.Is(err, ErrSignInRequired) {
			t.Fatalf("accepted invalid token: %v", err)
		}
	}
	opts := makeChat(t)
	handler, _ := makeHandler(t)
	opts.Config.Endpoint = "https://attacker.invalid"
	if _, _, _, err := backend.RunChatStep(context.Background(), handler, opts, nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("accepted endpoint override")
	}
	opts.Config.Endpoint = GatewayEndpoint
	opts.Config.ProxyURL = "http://attacker.invalid"
	if _, _, _, err := backend.RunChatStep(context.Background(), handler, opts, nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("accepted proxy override")
	}
	if calls != 0 {
		t.Fatal("sent invalid request")
	}
}

func TestContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	backend := &Backend{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("sent canceled request"); return nil, nil })}
	if _, err := backend.FetchModels(ctx, TestToken); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	backend.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := backend.FetchModels(ctx, TestToken); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline lost: %v", err)
	}
}

func TestMultimodalProjectionDoesNotLeakOrMutate(t *testing.T) {
	stored := &openaichat.StoredChatMessage{MessageId: "image", Message: openaichat.ChatRequestMessage{Role: "user", ContentParts: []openaichat.ChatContentPart{
		{Type: "image_url", ImageUrl: &openaichat.ChatImageUrl{Url: "data:image/png;base64,dGVzdA=="}, FileName: "private-file", PreviewUrl: "private-preview", MimeType: "image/png"},
	}}}
	opts := uctypes.WaveChatOpts{TabState: "context", Config: uctypes.AIOptsType{Capabilities: []string{uctypes.AICapabilityImages}}}
	chat := &uctypes.AIChat{NativeMessages: []uctypes.GenAIMessage{stored}}
	req, err := makeRequest(chat, opts, "model")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(req)
	if strings.Contains(string(data), "private-") || len(stored.Message.ContentParts) != 1 {
		t.Fatal("metadata leak or history mutation")
	}
	if !strings.Contains(string(data), "data:image/png") || !strings.Contains(string(data), "context") {
		t.Fatal("image or tab context dropped")
	}
	opts.Config.Capabilities = nil
	if _, err := makeRequest(chat, opts, "model"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("accepted unsupported image")
	}
}

func TestRemovalPreservesAssistantText(t *testing.T) {
	opts := makeChat(t)
	backend := &Backend{}
	msg := &openaichat.StoredChatMessage{MessageId: "assistant", Message: openaichat.ChatRequestMessage{
		Role: "assistant", Content: "Let me check", ToolCalls: []openaichat.ToolCall{{ID: "cancel-me", Type: "function"}},
	}}
	if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
		t.Fatal(err)
	}
	if err := backend.RemoveToolUseCall(opts.ChatId, "cancel-me"); err != nil {
		t.Fatal(err)
	}
	chat := chatstore.DefaultChatStore.Get(opts.ChatId)
	if len(chat.NativeMessages) != 2 {
		t.Fatal("removed accompanying text")
	}
	updated := chat.NativeMessages[1].(*openaichat.StoredChatMessage)
	if updated.Message.Content != "Let me check" || len(updated.Message.ToolCalls) != 0 || len(msg.Message.ToolCalls) != 1 {
		t.Fatal("bad removal or mutation")
	}
}

func TestSSEFullQueueFailsWithoutPartialLifecycle(t *testing.T) {
	handler, _ := makeHandler(t)
	for i := 0; i < 10; i++ {
		if err := handler.WriteData(`{"type":"test"}`); err != nil {
			t.Fatal(err)
		}
	}
	msg := &openaichat.StoredChatMessage{MessageId: "test", Message: openaichat.ChatRequestMessage{Content: "complete text"}}
	err := emitResponse(context.Background(), handler, msg, &uctypes.WaveContinueResponse{}, &uctypes.WaveStopReason{Kind: uctypes.StopKindDone})
	if !errors.Is(err, ErrGateway) {
		t.Fatalf("full queue failure not propagated: %v", err)
	}
}

func TestPostQuotaFailureIsNotRetried(t *testing.T) {
	opts := makeChat(t)
	requests := 0
	backend := &Backend{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.Method == http.MethodGet {
			return response(200, TestModels), nil
		}
		return response(402, `{"detail":{"code":"free_daily_cap","message":"`+TestToken+`"}}`), nil
	})}
	handler, recorder := makeHandler(t)
	_, messages, _, err := backend.RunChatStep(context.Background(), handler, opts, nil)
	if !errors.Is(err, ErrFreeDailyCap) || requests != 2 || len(messages) != 0 || recorder.Body.Len() != 0 {
		t.Fatalf("bad quota handling: %v", err)
	}
}

func TestBodyReadErrorsDoNotLeakCredentials(t *testing.T) {
	backend := &Backend{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(errorReader{})}, nil
	})}
	if _, err := backend.FetchModels(context.Background(), TestToken); !errors.Is(err, ErrGateway) || strings.Contains(err.Error(), TestToken) {
		t.Fatalf("unsafe read error: %v", err)
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New(TestToken) }

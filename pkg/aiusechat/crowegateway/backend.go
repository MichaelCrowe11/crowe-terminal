// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package crowegateway

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/chatstore"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/openaichat"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

type Backend struct {
	Transport http.RoundTripper
}

// Wire types intentionally exclude local approval state and attachment metadata.
type requestMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type contentPart struct {
	Type     string                   `json:"type"`
	Text     string                   `json:"text,omitempty"`
	ImageURL *openaichat.ChatImageUrl `json:"image_url,omitempty"`
}

type toolCall struct {
	ID       string                      `json:"id"`
	Type     string                      `json:"type"`
	Function openaichat.ToolFunctionCall `json:"function"`
}

type chatRequest struct {
	Model     string                      `json:"model"`
	Messages  []requestMessage            `json:"messages"`
	MaxTokens int                         `json:"max_tokens,omitempty"`
	Tools     []openaichat.ToolDefinition `json:"tools,omitempty"`
}

type chatResponse struct {
	ID        string                `json:"id"`
	Model     string                `json:"model"`
	Content   *string               `json:"content"`
	Usage     *openaichat.ChatUsage `json:"usage"`
	LatencyMs int64                 `json:"latency_ms"`
	ToolCalls []toolCall            `json:"tool_calls"`
}

func makeRequest(chat *uctypes.AIChat, opts uctypes.WaveChatOpts, model string) (*chatRequest, error) {
	if chat == nil || len(chat.NativeMessages) == 0 || opts.Config.MaxTokens < 0 {
		return nil, ErrInvalidRequest
	}
	req := &chatRequest{Model: model, MaxTokens: opts.Config.MaxTokens}
	if len(opts.SystemPrompt) > 0 {
		req.Messages = append(req.Messages, requestMessage{Role: "system", Content: strings.Join(opts.SystemPrompt, "\n\n")})
	}
	for _, native := range chat.NativeMessages {
		stored, ok := native.(*openaichat.StoredChatMessage)
		if !ok || stored == nil {
			return nil, ErrInvalidRequest
		}
		message := stored.Message
		switch message.Role {
		case "system", "user", "assistant", "tool":
		default:
			return nil, ErrInvalidRequest
		}
		wire := requestMessage{Role: message.Role, Content: message.Content, ToolCallID: message.ToolCallID, Name: message.Name}
		if len(message.ContentParts) > 0 {
			parts := make([]contentPart, 0, len(message.ContentParts))
			for _, part := range message.ContentParts {
				switch part.Type {
				case "text":
					parts = append(parts, contentPart{Type: "text", Text: part.Text})
				case "image_url":
					if !opts.Config.HasCapability(uctypes.AICapabilityImages) || part.ImageUrl == nil {
						return nil, ErrInvalidRequest
					}
					parts = append(parts, contentPart{Type: "image_url", ImageURL: part.ImageUrl})
				default:
					return nil, ErrInvalidRequest
				}
			}
			wire.Content = parts
		}
		for _, call := range message.ToolCalls {
			wire.ToolCalls = append(wire.ToolCalls, toolCall{ID: call.ID, Type: call.Type, Function: call.Function})
		}
		req.Messages = append(req.Messages, wire)
	}
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role != "user" {
			continue
		}
		for _, extra := range []string{opts.TabState, platformInfo(opts.PlatformInfo)} {
			if extra == "" {
				continue
			}
			switch content := req.Messages[i].Content.(type) {
			case string:
				req.Messages[i].Content = content + "\n\n" + extra
			case []contentPart:
				req.Messages[i].Content = append(content, contentPart{Type: "text", Text: extra})
			}
		}
		break
	}
	opts.RestrictToolCatalog()
	if opts.Config.HasCapability(uctypes.AICapabilityTools) {
		for _, tools := range [][]uctypes.ToolDefinition{opts.Tools, opts.TabTools} {
			for _, tool := range tools {
				if !tool.HasRequiredCapabilities(opts.Config.Capabilities) {
					continue
				}
				req.Tools = append(req.Tools, openaichat.ToolDefinition{Type: "function", Function: openaichat.ToolFunctionDef{
					Name: tool.Name, Description: tool.Description, Parameters: tool.InputSchema,
				}})
			}
		}
	}
	return req, nil
}

func platformInfo(info string) string {
	if info == "" {
		return ""
	}
	return "<PlatformInfo>\n" + info + "\n</PlatformInfo>"
}

func validateResponse(resp *chatResponse, req *chatRequest) ([]uctypes.WaveToolCall, error) {
	if resp.ID == "" || resp.Model == "" || resp.LatencyMs < 0 || resp.Usage == nil || resp.Usage.InputTokens < 0 || resp.Usage.OutputTokens < 0 || resp.Usage.TotalTokens < 0 {
		return nil, ErrInvalidResponse
	}
	if (resp.Content == nil || *resp.Content == "") && len(resp.ToolCalls) == 0 {
		return nil, ErrInvalidResponse
	}
	offered := make(map[string]bool, len(req.Tools))
	for _, tool := range req.Tools {
		offered[tool.Function.Name] = true
	}
	seen := make(map[string]bool)
	for _, msg := range req.Messages {
		for _, call := range msg.ToolCalls {
			seen[call.ID] = true
		}
	}
	var calls []uctypes.WaveToolCall
	for _, call := range resp.ToolCalls {
		if call.ID == "" || seen[call.ID] || call.Type != "function" || !offered[call.Function.Name] {
			return nil, ErrInvalidResponse
		}
		var input map[string]any
		if json.Unmarshal([]byte(call.Function.Arguments), &input) != nil || input == nil {
			return nil, ErrInvalidResponse
		}
		seen[call.ID] = true
		calls = append(calls, uctypes.WaveToolCall{ID: call.ID, Name: call.Function.Name, Input: input})
	}
	return calls, nil
}

func (b *Backend) RunChatStep(ctx context.Context, handler *sse.SSEHandlerCh, opts uctypes.WaveChatOpts, cont *uctypes.WaveContinueResponse) (*uctypes.WaveStopReason, []uctypes.GenAIMessage, *uctypes.RateLimitInfo, error) {
	if handler == nil {
		return nil, nil, nil, ErrInvalidRequest
	}
	if err := handler.Err(); err != nil {
		return nil, nil, nil, ErrGateway
	}
	timeout := DefaultTimeout
	if opts.Config.TimeoutMs > 0 {
		timeout = time.Duration(opts.Config.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Endpoint and proxy overrides must never redirect account credentials.
	if (opts.Config.Endpoint != "" && opts.Config.Endpoint != GatewayEndpoint) || opts.Config.ProxyURL != "" {
		return nil, nil, nil, ErrInvalidRequest
	}
	models, err := b.FetchModels(ctx, opts.Config.APIToken)
	if err != nil {
		return nil, nil, nil, err
	}
	model, err := models.SelectModel(opts.Config.Model)
	if err != nil {
		return nil, nil, nil, err
	}
	req, err := makeRequest(chatstore.DefaultChatStore.Get(opts.ChatId), opts, model)
	if err != nil {
		return nil, nil, nil, err
	}
	var resp chatResponse
	if err := b.request(ctx, http.MethodPost, GatewayEndpoint, opts.Config.APIToken, req, &resp); err != nil {
		return nil, nil, nil, err
	}
	calls, err := validateResponse(&resp, req)
	if err != nil {
		return nil, nil, nil, err
	}
	msg := &openaichat.StoredChatMessage{MessageId: uuid.NewString(), Message: openaichat.ChatRequestMessage{Role: "assistant"}, Usage: resp.Usage}
	msg.Usage.Model = resp.Model
	if resp.Content != nil {
		msg.Message.Content = *resp.Content
	}
	for _, call := range resp.ToolCalls {
		msg.Message.ToolCalls = append(msg.Message.ToolCalls, openaichat.ToolCall{ID: call.ID, Type: call.Type, Function: call.Function})
	}
	stop := &uctypes.WaveStopReason{Kind: uctypes.StopKindDone, RawReason: "stop"}
	if len(calls) > 0 {
		stop.Kind = uctypes.StopKindToolUse
		stop.RawReason = "tool_calls"
		stop.ToolCalls = calls
	}
	if err := emitResponse(ctx, handler, msg, cont, stop); err != nil {
		return nil, nil, nil, err
	}
	return stop, []uctypes.GenAIMessage{msg}, nil, nil
}

func emitResponse(ctx context.Context, handler *sse.SSEHandlerCh, msg *openaichat.StoredChatMessage, cont *uctypes.WaveContinueResponse, stop *uctypes.WaveStopReason) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if cont == nil {
		if err := handler.SetupSSE(); err != nil {
			return ErrGateway
		}
	}
	var events []map[string]any
	if cont == nil {
		events = append(events, map[string]any{"type": "start", "messageId": msg.MessageId})
	}
	events = append(events, map[string]any{"type": "start-step"})
	if msg.Message.Content != "" {
		id := uuid.NewString()
		events = append(events,
			map[string]any{"type": "text-start", "id": id},
			map[string]any{"type": "text-delta", "id": id, "delta": msg.Message.Content},
			map[string]any{"type": "text-end", "id": id},
		)
	}
	events = append(events, map[string]any{"type": "finish-step"})
	if stop.Kind != uctypes.StopKindToolUse {
		events = append(events, map[string]any{"type": "finish"})
	}
	// WriteData wraps its string with "data: " and a blank line. One queue item
	// keeps this non-stream response's lifecycle together in the bounded SSE queue.
	frames := make([]string, len(events))
	for i, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			return ErrInvalidResponse
		}
		frames[i] = string(data)
	}
	if err := handler.WriteData(strings.Join(frames, "\n\ndata: ")); err != nil {
		return ErrGateway
	}
	return nil
}

func (b *Backend) UpdateToolUseData(chatId, callId string, data uctypes.UIMessageDataToolUse) error {
	return openaichat.UpdateToolUseData(chatId, callId, data)
}

func (b *Backend) RemoveToolUseCall(chatId, callId string) error {
	chat := chatstore.DefaultChatStore.Get(chatId)
	if chat == nil {
		return ErrInvalidRequest
	}
	for _, native := range chat.NativeMessages {
		msg, ok := native.(*openaichat.StoredChatMessage)
		if !ok || msg == nil {
			continue
		}
		idx := msg.Message.FindToolCallIndex(callId)
		if idx < 0 {
			continue
		}
		updated := msg.Copy()
		updated.Message.ToolCalls = append(updated.Message.ToolCalls[:idx], updated.Message.ToolCalls[idx+1:]...)
		// Unlike the streaming converter, gateway responses retain text alongside tools.
		if len(updated.Message.ToolCalls) == 0 && updated.Message.Content == "" && len(updated.Message.ContentParts) == 0 {
			chatstore.DefaultChatStore.RemoveMessage(chatId, msg.MessageId)
			return nil
		}
		return chatstore.DefaultChatStore.PostMessage(chatId, &uctypes.AIOptsType{APIType: chat.APIType, Model: chat.Model, APIVersion: chat.APIVersion}, updated)
	}
	return nil
}

func (b *Backend) ConvertToolResultsToNativeChatMessage(results []uctypes.AIToolResult) ([]uctypes.GenAIMessage, error) {
	return openaichat.ConvertToolResultsToNativeChatMessage(results)
}

func (b *Backend) ConvertAIMessageToNativeChatMessage(message uctypes.AIMessage) (uctypes.GenAIMessage, error) {
	return openaichat.ConvertAIMessageToStoredChatMessage(message)
}

func (b *Backend) GetFunctionCallInputByToolCallId(chat uctypes.AIChat, callId string) *uctypes.AIFunctionCallInput {
	return openaichat.GetFunctionCallInputByToolCallId(chat, callId)
}

func (b *Backend) ConvertAIChatToUIChat(chat uctypes.AIChat) (*uctypes.UIChat, error) {
	return openaichat.ConvertAIChatToUIChat(chat)
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/crowegateway"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/croweauth"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

type croweAccountBackend struct {
	crowegateway.Backend
	manager *croweauth.Manager
}

func (b *croweAccountBackend) RunChatStep(ctx context.Context, handler *sse.SSEHandlerCh, opts uctypes.WaveChatOpts, cont *uctypes.WaveContinueResponse) (*uctypes.WaveStopReason, []uctypes.GenAIMessage, *uctypes.RateLimitInfo, error) {
	manager := b.manager
	if manager == nil {
		manager = croweauth.Default()
	}
	token, err := manager.Token(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	opts.Config.APIToken = token
	stop, messages, limits, err := b.Backend.RunChatStep(ctx, handler, opts, cont)
	if errors.Is(err, crowegateway.ErrSignInRequired) {
		manager.RejectToken(ctx, token)
		return nil, nil, nil, croweauth.ErrSignInRequired
	}
	return stop, messages, limits, err
}

var _ UseChatBackend = (*croweAccountBackend)(nil)

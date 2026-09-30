// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/croweauth"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const croweAuthStorageUnavailable = "Crowe account secure storage is unavailable"
const croweAuthDisconnectWarning = "Disconnected locally; secure credential cleanup failed. Disconnection may not survive an app restart."

func croweAuthResponse(status croweauth.Status, err error) (*wshrpc.CroweAuthStatus, error) {
	if err != nil {
		// RPC errors discard response data, so only these fixed operational statuses may succeed.
		switch status.Message {
		case croweAuthStorageUnavailable:
			return &wshrpc.CroweAuthStatus{State: croweauth.StateError, Message: croweAuthStorageUnavailable}, nil
		case croweAuthDisconnectWarning:
			return &wshrpc.CroweAuthStatus{State: croweauth.StateSignedOut, Message: croweAuthDisconnectWarning}, nil
		default:
			return nil, errors.New("Crowe account operation failed")
		}
	}
	return &wshrpc.CroweAuthStatus{
		State:           status.State,
		UserCode:        status.UserCode,
		VerificationURL: status.VerificationURL,
		ExpiresAt:       status.ExpiresAt,
		Message:         status.Message,
	}, nil
}

func (ws *WshServer) CroweAuthStatusCommand(ctx context.Context) (*wshrpc.CroweAuthStatus, error) {
	if err := wshutil.DefaultRouter.RequireLocalFrontend(ctx); err != nil {
		return nil, err
	}
	return croweAuthResponse(croweauth.Default().Status(ctx))
}

func (ws *WshServer) CroweAuthStartCommand(ctx context.Context) (*wshrpc.CroweAuthStatus, error) {
	if err := wshutil.DefaultRouter.RequireLocalFrontend(ctx); err != nil {
		return nil, err
	}
	return croweAuthResponse(croweauth.Default().Start(ctx))
}

func (ws *WshServer) CroweAuthCancelCommand(ctx context.Context) (*wshrpc.CroweAuthStatus, error) {
	if err := wshutil.DefaultRouter.RequireLocalFrontend(ctx); err != nil {
		return nil, err
	}
	return croweAuthResponse(croweauth.Default().Cancel(ctx))
}

func (ws *WshServer) CroweAuthDisconnectCommand(ctx context.Context) (*wshrpc.CroweAuthStatus, error) {
	if err := wshutil.DefaultRouter.RequireLocalFrontend(ctx); err != nil {
		return nil, err
	}
	return croweAuthResponse(croweauth.Default().Disconnect(ctx))
}

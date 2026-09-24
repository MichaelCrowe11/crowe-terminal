// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package crowegateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	GatewayEndpoint     = "https://api.crowelogic.com/api/gateway/chat"
	ModelsEndpoint      = "https://api.crowelogic.com/api/gateway/models"
	AccountDefaultModel = "crowelm-account-default"
	MaxResponseBytes    = 4 * 1024 * 1024
	MaxRequestBytes     = 16 * 1024 * 1024
	DefaultTimeout      = 2 * time.Minute
)

var (
	ErrSignInRequired   = errors.New("Sign in to your Crowe account to continue")
	ErrFreeDailyCap     = errors.New("Your free daily Crowe chat limit has been reached. Try again tomorrow or choose a paid plan. Tool follow-up turns also count toward this limit")
	ErrQuota            = errors.New("Your Crowe account usage limit has been reached")
	ErrPlan             = errors.New("This model is not included in your Crowe plan. Choose an available model")
	ErrModelRetired     = errors.New("This Crowe model has been retired. Choose an available model")
	ErrModelUnavailable = errors.New("The selected model is not available for your Crowe account. Choose an available model")
	ErrRateLimit        = errors.New("Crowe is rate limiting requests. Please try again later")
	ErrGateway          = errors.New("The Crowe gateway could not complete the request")
	ErrInvalidResponse  = errors.New("The Crowe gateway returned an invalid response")
	ErrResponseTooLarge = errors.New("The Crowe gateway response exceeded the size limit")
	ErrInvalidRequest   = errors.New("The Crowe gateway request is invalid or unsupported")
	ErrRedirect         = errors.New("The Crowe gateway returned a redirect; the request was not followed")
)

var gatewayTransport = &http.Transport{
	DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          20,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: time.Second,
}

type Model struct {
	Model       string `json:"model"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MinPlan     string `json:"min_plan"`
	Group       string `json:"group"`
	Engine      string `json:"engine,omitempty"`
	Provider    string `json:"provider,omitempty"`
	HostedOn    string `json:"hosted_on,omitempty"`
}

type ModelsResponse struct {
	Plan         string  `json:"plan"`
	DefaultModel string  `json:"default_model"`
	Models       []Model `json:"models"`
}

func (m *ModelsResponse) SelectModel(selection string) (string, error) {
	if m == nil || m.Plan == "" || len(m.Models) == 0 {
		return "", ErrInvalidResponse
	}
	available := make(map[string]bool, len(m.Models))
	for _, model := range m.Models {
		if model.Model == "" || model.Model == AccountDefaultModel || available[model.Model] {
			return "", ErrInvalidResponse
		}
		available[model.Model] = true
	}
	if !available[m.DefaultModel] {
		return "", ErrInvalidResponse
	}
	if selection == "" || selection == AccountDefaultModel {
		return m.DefaultModel, nil
	}
	if !available[selection] {
		return "", ErrModelUnavailable
	}
	return selection, nil
}

func FetchModels(ctx context.Context, token string) (*ModelsResponse, error) {
	return (&Backend{}).FetchModels(ctx, token)
}

func (b *Backend) FetchModels(ctx context.Context, token string) (*ModelsResponse, error) {
	var models ModelsResponse
	if err := b.request(ctx, http.MethodGet, ModelsEndpoint, token, nil, &models); err != nil {
		return nil, err
	}
	if _, err := models.SelectModel(AccountDefaultModel); err != nil {
		return nil, err
	}
	return &models, nil
}

func (b *Backend) request(ctx context.Context, method, endpoint, token string, payload any, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return ErrSignInRequired
	}
	if (method != http.MethodGet || endpoint != ModelsEndpoint) && (method != http.MethodPost || endpoint != GatewayEndpoint) {
		return ErrInvalidRequest
	}
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil || len(body) > MaxRequestBytes {
			return ErrInvalidRequest
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return ErrInvalidRequest
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	transport := b.Transport
	if transport == nil {
		transport = gatewayTransport
	}
	client := &http.Client{
		Transport:     transport,
		Timeout:       DefaultTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrGateway
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return ErrRedirect
	}
	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return ErrGateway
	}
	if len(data) > MaxResponseBytes {
		return ErrResponseTooLarge
	}
	if err := json.Unmarshal(data, result); err != nil {
		return ErrInvalidResponse
	}
	return nil
}

func responseError(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return ErrSignInRequired
	case http.StatusPaymentRequired:
		var detail struct {
			Detail struct {
				Code string `json:"code"`
			} `json:"detail"`
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024+1))
		if err == nil && len(data) <= 16*1024 && json.Unmarshal(data, &detail) == nil && detail.Detail.Code == "free_daily_cap" {
			return ErrFreeDailyCap
		}
		return ErrQuota
	case http.StatusForbidden:
		return ErrPlan
	case http.StatusGone:
		return ErrModelRetired
	case http.StatusTooManyRequests:
		return ErrRateLimit
	default:
		return ErrGateway
	}
}

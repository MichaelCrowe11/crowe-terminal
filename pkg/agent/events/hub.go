// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package events

import (
	"encoding/json"
	"sync"
	"time"
)

const (
	KindCallStarted     = "call_started"
	KindCallCompleted   = "call_completed"
	KindCommandProposed = "command_proposed"
	KindCommandApproved = "command_approved"
	KindCommandRejected = "command_rejected"
	KindToolStream      = "tool_stream"
)

type Event struct {
	Kind       string          `json:"kind"`
	ToolName   string          `json:"toolname,omitempty"`
	ToolCallID string          `json:"toolcallid,omitempty"`
	BlockID    string          `json:"blockid,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	IsError    bool            `json:"iserror,omitempty"`
	TS         int64           `json:"ts"`
}

type Hub struct {
	lock    sync.RWMutex
	subs    map[chan Event]struct{}
	bufSize int
}

func MakeHub() *Hub {
	return &Hub{subs: make(map[chan Event]struct{}), bufSize: 64}
}

func (h *Hub) Subscribe() chan Event {
	ch := make(chan Event, h.bufSize)
	h.lock.Lock()
	h.subs[ch] = struct{}{}
	h.lock.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.lock.Lock()
	defer h.lock.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

func (h *Hub) Publish(ev Event) {
	if ev.TS == 0 {
		ev.TS = time.Now().UnixMilli()
	}
	h.lock.RLock()
	defer h.lock.RUnlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// drop on slow consumer; lifecycle events are best-effort
		}
	}
}

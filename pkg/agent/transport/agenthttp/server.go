// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package agenthttp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wavetermdev/waveterm/pkg/agent/events"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/authkey"
)

const (
	DefaultPort = 8012
	DefaultHost = "127.0.0.1"
)

type Server struct {
	host     string
	port     int
	listener net.Listener
	srv      *http.Server
	upgrader websocket.Upgrader
	hub      *events.Hub

	subsLock sync.RWMutex
	subs     map[*websocket.Conn]chan struct{}
}

func MakeServer(host string, port int, hub *events.Hub) *Server {
	if host == "" {
		host = DefaultHost
	}
	if port == 0 {
		port = DefaultPort
	}
	return &Server{
		host: host,
		port: port,
		hub:  hub,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return isLoopback(r)
			},
		},
		subs: make(map[*websocket.Conn]chan struct{}),
	}
}

func (s *Server) Addr() string {
	if s.listener == nil {
		return fmt.Sprintf("%s:%d", s.host, s.port)
	}
	return s.listener.Addr().String()
}

func (s *Server) Start(ctx context.Context) error {
	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("agent transport listen %s: %w", addr, err)
	}
	s.listener = ln

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/v1/tools", s.guard(s.handleTools))
	mux.HandleFunc("/v1/call", s.guard(s.handleCall))
	mux.HandleFunc("/v1/events", s.guard(s.handleEvents))

	s.srv = &http.Server{
		Handler:           loopbackOnly(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[agent] transport listening on %s\n", ln.Addr())
		if err := s.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[agent] transport serve error: %v\n", err)
		}
	}()

	go s.fanout(ctx)
	return nil
}

func (s *Server) Stop(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Shutdown(ctx)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"service":"crowe-agent"}`))
}

func (s *Server) handleTools(w http.ResponseWriter, _ *http.Request) {
	cat := registry.Default().Catalog()
	writeJSON(w, http.StatusOK, map[string]any{"tools": cat})
}

func (s *Server) handleCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req registry.CallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if s.hub != nil {
		s.hub.Publish(events.Event{Kind: events.KindCallStarted, ToolName: req.Name, ToolCallID: req.ToolCallID})
	}
	res, err := registry.Default().Call(ctx, req)
	if s.hub != nil {
		s.hub.Publish(events.Event{
			Kind:       events.KindCallCompleted,
			ToolName:   req.Name,
			ToolCallID: req.ToolCallID,
			IsError:    res.IsError || err != nil,
		})
	}
	if err != nil && !res.IsError {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[agent] ws upgrade: %v\n", err)
		return
	}
	done := make(chan struct{})
	s.subsLock.Lock()
	s.subs[conn] = done
	s.subsLock.Unlock()
	go func() {
		for {
			if _, _, err := conn.NextReader(); err != nil {
				close(done)
				s.subsLock.Lock()
				delete(s.subs, conn)
				s.subsLock.Unlock()
				_ = conn.Close()
				return
			}
		}
	}()
}

func (s *Server) fanout(ctx context.Context) {
	if s.hub == nil {
		return
	}
	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			s.broadcast(ev)
		}
	}
}

func (s *Server) broadcast(ev events.Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return
	}
	s.subsLock.RLock()
	conns := make([]*websocket.Conn, 0, len(s.subs))
	for c := range s.subs {
		conns = append(conns, c)
	}
	s.subsLock.RUnlock()
	for _, c := range conns {
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = c.WriteMessage(websocket.TextMessage, payload)
	}
}

func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := authkey.ValidateIncomingRequest(r); err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

func loopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r) {
			http.Error(w, "loopback only", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

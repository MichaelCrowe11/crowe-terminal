// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import "sync"

type MemoryStore struct {
	lock   sync.RWMutex
	grants map[string]*CapabilityGrant
}

func MakeMemoryStore() *MemoryStore {
	return &MemoryStore{grants: make(map[string]*CapabilityGrant)}
}

func grantKey(blockID, agentSessionID string) string {
	return blockID + "\x00" + agentSessionID
}

func (s *MemoryStore) Get(blockID, agentSessionID string) (*CapabilityGrant, bool) {
	s.lock.RLock()
	defer s.lock.RUnlock()
	g, ok := s.grants[grantKey(blockID, agentSessionID)]
	return g, ok
}

func (s *MemoryStore) Put(grant *CapabilityGrant) {
	if grant == nil || grant.BlockID == "" || grant.AgentSessionID == "" {
		return
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	s.grants[grantKey(grant.BlockID, grant.AgentSessionID)] = grant
}

func (s *MemoryStore) Promote(blockID, agentSessionID, toolName string, mode string) {
	if blockID == "" || agentSessionID == "" || toolName == "" {
		return
	}
	if mode != ModeDeny && mode != ModeAsk && mode != ModeAllow {
		return
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	key := grantKey(blockID, agentSessionID)
	g, ok := s.grants[key]
	if !ok {
		g = &CapabilityGrant{
			BlockID:        blockID,
			AgentSessionID: agentSessionID,
			Tools:          make(map[string]string),
		}
		s.grants[key] = g
	}
	if g.Tools == nil {
		g.Tools = make(map[string]string)
	}
	g.Tools[toolName] = mode
}

func (s *MemoryStore) Revoke(blockID, agentSessionID string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	delete(s.grants, grantKey(blockID, agentSessionID))
}

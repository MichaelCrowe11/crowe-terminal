// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig/defaultconfig"
)

// The shipped CroweLM modes must reach the Crowe Logic model edge with no
// local server and no credential in source: the release build compiles the
// credential in (wavebase.CroweModelsKey) behind the CROWE_MODELS_KEY secret
// name, and users can override it with a secret of that name.
func TestShippedCroweLMModesUseTheModelEdge(t *testing.T) {
	const edge = "https://models.crowelogic.com/v1/chat/completions"
	edgeModels := map[string]bool{
		"crowelm-apex": true, "crowelm-titan": true, "crowelm-reason": true, "crowelm-quasar": true,
		"crowelm-quasar-fast": true, "crowelm-flash": true, "crowelm-swift": true, "crowelm-vector": true,
		"crowelm-herald": true, "crowelm-eclipse": true, "crowelm-coder": true,
	}
	raw, err := defaultconfig.ConfigFS.ReadFile("waveai.json")
	if err != nil {
		t.Fatalf("read defaults waveai.json: %v", err)
	}
	var modes map[string]AIModeConfigType
	if err := json.Unmarshal(raw, &modes); err != nil {
		t.Fatalf("parse waveai.json: %v", err)
	}
	cloud := 0
	for name, m := range modes {
		if !strings.HasPrefix(name, "waveai@crowelm-") {
			continue
		}
		if name == "waveai@crowelm-local" {
			if !strings.HasPrefix(m.Endpoint, "http://127.0.0.1:8011/") {
				t.Errorf("%s: local mode must stay on the foundry bridge, got %q", name, m.Endpoint)
			}
			continue
		}
		cloud++
		if m.Endpoint != edge {
			t.Errorf("%s: endpoint %q, want %q", name, m.Endpoint, edge)
		}
		if !edgeModels[m.Model] {
			t.Errorf("%s: model %q is not an id the edge serves", name, m.Model)
		}
		if m.APIToken != "" {
			t.Errorf("%s: ai:apitoken must not be set in source", name)
		}
		if m.APITokenSecretName != "CROWE_MODELS_KEY" {
			t.Errorf("%s: secret name %q, want CROWE_MODELS_KEY", name, m.APITokenSecretName)
		}
	}
	if cloud != 5 {
		t.Errorf("expected 5 cloud CroweLM modes, found %d", cloud)
	}
	if strings.Contains(string(raw), "hyph_") {
		t.Error("a credential leaked into waveai.json")
	}
}

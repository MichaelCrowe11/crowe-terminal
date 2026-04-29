// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

// withTempDB swaps the DB path to a temp dir for the duration of one test.
func withTempDB(t *testing.T) func() {
	t.Helper()
	path := filepath.Join(t.TempDir(), "farmlog.db")
	t.Setenv(EnvFarmDBPath, path)
	dbLock.Lock()
	if db != nil {
		_ = db.Close()
		db = nil
	}
	dbLock.Unlock()
	return func() {
		dbLock.Lock()
		if db != nil {
			_ = db.Close()
			db = nil
		}
		dbLock.Unlock()
	}
}

func TestRegistered(t *testing.T) {
	want := []string{
		"farm.batch_start", "farm.event", "farm.harvest",
		"farm.list_batches", "farm.batch_history", "farm.yield_summary",
		"farm.update_state",
	}
	for _, n := range want {
		if _, ok := registry.Default().Get(n); !ok {
			t.Errorf("tool %s not registered", n)
		}
	}
}

func TestFullCycle(t *testing.T) {
	defer withTempDB(t)()

	// Start a grain batch
	res, err := handleBatchStart(context.Background(), json.RawMessage(`{
		"kind":"grain","strain":"Lions Mane","substrate":"sterilized rye",
		"weight_kg":2.0,"technician":"crowe","notes":"5 jars"
	}`))
	if err != nil || res.IsError {
		t.Fatalf("batch_start: %v iserror=%v err=%s", err, res.IsError, res.ErrorText)
	}
	var startResp struct {
		BatchID int64 `json:"batch_id"`
	}
	_ = json.Unmarshal(res.Content, &startResp)
	if startResp.BatchID == 0 {
		t.Fatal("expected batch_id > 0")
	}
	bid := startResp.BatchID

	// Inoculate event
	if r, _ := handleEvent(context.Background(), json.RawMessage(`{
		"batch_id":`+toStr(bid)+`,"event_type":"inoculate","notes":"liquid culture 2ml each",
		"payload":{"lc_strain":"LM-A1","jars":5}
	}`)); r.IsError {
		t.Fatalf("event: %s", r.ErrorText)
	}

	// Harvest
	if r, _ := handleHarvest(context.Background(), json.RawMessage(`{
		"batch_id":`+toStr(bid)+`,"weight_kg":0.420,"quality":"A","flush_num":1,"notes":"first flush"
	}`)); r.IsError {
		t.Fatalf("harvest: %s", r.ErrorText)
	}

	// History returns full chain
	hres, err := handleBatchHistory(context.Background(), json.RawMessage(`{"batch_id":`+toStr(bid)+`}`))
	if err != nil || hres.IsError {
		t.Fatalf("history: %v %s", err, hres.ErrorText)
	}
	var hist struct {
		Batch    Batch     `json:"batch"`
		Events   []Event   `json:"events"`
		Harvests []Harvest `json:"harvests"`
	}
	_ = json.Unmarshal(hres.Content, &hist)
	if hist.Batch.ID != bid {
		t.Errorf("history batch id mismatch: %d != %d", hist.Batch.ID, bid)
	}
	if len(hist.Events) != 1 {
		t.Errorf("expected 1 event, got %d", len(hist.Events))
	}
	if len(hist.Harvests) != 1 {
		t.Errorf("expected 1 harvest, got %d", len(hist.Harvests))
	}
	if hist.Harvests[0].WeightKg != 0.42 {
		t.Errorf("harvest weight mismatch: %v", hist.Harvests[0].WeightKg)
	}

	// Yield summary
	yres, _ := handleYieldSummary(context.Background(), json.RawMessage(`{"strain":"Lions Mane"}`))
	if yres.IsError {
		t.Fatalf("yield: %s", yres.ErrorText)
	}
	var ys map[string]any
	_ = json.Unmarshal(yres.Content, &ys)
	if ys["batch_count"].(float64) != 1 {
		t.Errorf("expected batch_count=1, got %v", ys["batch_count"])
	}
	if ys["total_weight_kg"].(float64) != 0.42 {
		t.Errorf("expected 0.42, got %v", ys["total_weight_kg"])
	}

	// State update + auto-event
	if r, _ := handleUpdateState(context.Background(), json.RawMessage(`{
		"batch_id":`+toStr(bid)+`,"state":"finished","notes":"end of cycle"
	}`)); r.IsError {
		t.Fatalf("update_state: %s", r.ErrorText)
	}
	hres, _ = handleBatchHistory(context.Background(), json.RawMessage(`{"batch_id":`+toStr(bid)+`}`))
	_ = json.Unmarshal(hres.Content, &hist)
	if hist.Batch.State != "finished" {
		t.Errorf("expected finished, got %s", hist.Batch.State)
	}
	if len(hist.Events) != 2 {
		t.Errorf("expected 2 events after state change, got %d", len(hist.Events))
	}
}

func TestListFiltering(t *testing.T) {
	defer withTempDB(t)()
	for _, args := range []string{
		`{"kind":"grain","strain":"Lions Mane"}`,
		`{"kind":"grain","strain":"Blue Oyster"}`,
		`{"kind":"bag","strain":"Lions Mane"}`,
	} {
		_, _ = handleBatchStart(context.Background(), json.RawMessage(args))
	}
	res, _ := handleListBatches(context.Background(), json.RawMessage(`{"strain":"Lions Mane"}`))
	var listResp struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(res.Content, &listResp)
	if listResp.Count != 2 {
		t.Errorf("strain filter: expected 2, got %d", listResp.Count)
	}
	res, _ = handleListBatches(context.Background(), json.RawMessage(`{"kind":"bag"}`))
	_ = json.Unmarshal(res.Content, &listResp)
	if listResp.Count != 1 {
		t.Errorf("kind filter: expected 1, got %d", listResp.Count)
	}
}

func toStr(n int64) string {
	return jsonNum(n)
}

func jsonNum(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

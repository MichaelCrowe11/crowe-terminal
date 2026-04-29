// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportCSV(t *testing.T) {
	defer withTempDB(t)()

	// Seed a batch + event + harvest
	r, _ := handleBatchStart(context.Background(), json.RawMessage(`{
		"kind":"grain","strain":"Lions Mane","substrate":"sterilized rye"
	}`))
	var br struct{ BatchID int64 `json:"batch_id"` }
	_ = json.Unmarshal(r.Content, &br)
	_, _ = handleEvent(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"event_type":"inoculate","notes":"5 jars"
	}`))
	_, _ = handleHarvest(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"weight_kg":0.5,"quality":"A","flush_num":1
	}`))

	// Export
	tmp := t.TempDir()
	res, err := handleExportCSV(context.Background(), json.RawMessage(`{"out_dir":"`+tmp+`"}`))
	if err != nil || res.IsError {
		t.Fatalf("export: %v %s", err, res.ErrorText)
	}
	for _, name := range []string{"batches.csv", "events.csv", "harvests.csv"} {
		path := filepath.Join(tmp, name)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("missing %s: %v", path, err)
			continue
		}
		// Each file should have a header + at least one data line
		lines := strings.Count(strings.TrimSpace(string(b)), "\n")
		if lines < 1 {
			t.Errorf("%s: expected at least one data row, got: %s", name, string(b))
		}
	}
	// Spot-check batches.csv contains the strain
	body, _ := os.ReadFile(filepath.Join(tmp, "batches.csv"))
	if !strings.Contains(string(body), "Lions Mane") {
		t.Errorf("batches.csv missing Lions Mane: %s", string(body))
	}
}

func TestReportEmpty(t *testing.T) {
	defer withTempDB(t)()
	res, err := handleReport(context.Background(), json.RawMessage(`{"days":7}`))
	if err != nil || res.IsError {
		t.Fatalf("report: %v %s", err, res.ErrorText)
	}
	var resp struct {
		Markdown string `json:"markdown"`
	}
	_ = json.Unmarshal(res.Content, &resp)
	if !strings.Contains(resp.Markdown, "No activity in this window") {
		t.Errorf("expected empty-window note, got:\n%s", resp.Markdown)
	}
}

func TestReportPopulated(t *testing.T) {
	defer withTempDB(t)()
	// Seed a batch with harvest + contam
	r, _ := handleBatchStart(context.Background(), json.RawMessage(`{"kind":"bag","strain":"Blue Oyster"}`))
	var br struct{ BatchID int64 `json:"batch_id"` }
	_ = json.Unmarshal(r.Content, &br)
	_, _ = handleHarvest(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"weight_kg":0.380,"quality":"A","flush_num":1,"notes":"first flush"
	}`))
	_, _ = handleEvent(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"event_type":"contam","notes":"trichoderma in corner"
	}`))

	res, err := handleReport(context.Background(), json.RawMessage(`{"days":30}`))
	if err != nil || res.IsError {
		t.Fatalf("report: %v %s", err, res.ErrorText)
	}
	var resp struct {
		NewBatches int    `json:"new_batches"`
		Harvests   int    `json:"harvests"`
		Markdown   string `json:"markdown"`
	}
	_ = json.Unmarshal(res.Content, &resp)
	if resp.NewBatches != 1 {
		t.Errorf("expected 1 new batch, got %d", resp.NewBatches)
	}
	if resp.Harvests != 1 {
		t.Errorf("expected 1 harvest, got %d", resp.Harvests)
	}
	for _, want := range []string{"Blue Oyster", "0.380", "trichoderma", "## Harvests", "## Contamination"} {
		if !strings.Contains(resp.Markdown, want) {
			t.Errorf("markdown missing %q\n--- markdown ---\n%s", want, resp.Markdown)
		}
	}
}

func TestReportWritesFile(t *testing.T) {
	defer withTempDB(t)()
	_, _ = handleBatchStart(context.Background(), json.RawMessage(`{"kind":"grain"}`))
	out := filepath.Join(t.TempDir(), "report.md")
	res, _ := handleReport(context.Background(), json.RawMessage(`{"days":7,"out_path":"`+out+`"}`))
	if res.IsError {
		t.Fatalf("report: %s", res.ErrorText)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read written report: %v", err)
	}
	if !strings.Contains(string(b), "Crowe Farm Report") {
		t.Errorf("written report missing title: %s", string(b))
	}
}

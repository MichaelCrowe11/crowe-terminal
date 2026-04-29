// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAttachPhotoExisting(t *testing.T) {
	defer withTempDB(t)()

	// Seed a batch
	r, _ := handleBatchStart(context.Background(), json.RawMessage(`{"kind":"bag","strain":"Lions Mane"}`))
	var br struct{ BatchID int64 `json:"batch_id"` }
	_ = json.Unmarshal(r.Content, &br)

	// Make a fake "photo" on disk
	tmp := t.TempDir()
	src := filepath.Join(tmp, "fake-photo.png")
	if err := os.WriteFile(src, []byte("\x89PNG\r\n\x1a\nfake-image-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handleAttachPhoto(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"mode":"none","path":"`+src+`","notes":"flush 1 first day"
	}`))
	if err != nil || res.IsError {
		t.Fatalf("attach: %v %s", err, res.ErrorText)
	}
	var resp struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	_ = json.Unmarshal(res.Content, &resp)
	if resp.Size == 0 {
		t.Errorf("expected non-zero size")
	}
	if _, err := os.Stat(resp.Path); err != nil {
		t.Errorf("archived file not found: %v", err)
	}
}

func TestLogSensorAndSummary(t *testing.T) {
	defer withTempDB(t)()
	r, _ := handleBatchStart(context.Background(), json.RawMessage(`{"kind":"bag"}`))
	var br struct{ BatchID int64 `json:"batch_id"` }
	_ = json.Unmarshal(r.Content, &br)

	for _, reading := range []string{
		`{"batch_id":` + jsonNum(br.BatchID) + `,"temp_f":62,"humidity":92,"co2_ppm":800}`,
		`{"batch_id":` + jsonNum(br.BatchID) + `,"temp_f":64,"humidity":91,"co2_ppm":900}`,
		`{"batch_id":` + jsonNum(br.BatchID) + `,"temp_f":65,"humidity":90,"co2_ppm":850}`,
	} {
		res, _ := handleLogSensor(context.Background(), json.RawMessage(reading))
		if res.IsError {
			t.Fatalf("log: %s", res.ErrorText)
		}
	}

	res, _ := handleSensorSummary(context.Background(), json.RawMessage(`{"batch_id":`+jsonNum(br.BatchID)+`}`))
	if res.IsError {
		t.Fatalf("summary: %s", res.ErrorText)
	}
	var summary struct {
		TempF    *sensorAgg `json:"temp_f"`
		Humidity *sensorAgg `json:"humidity"`
		CO2PPM   *sensorAgg `json:"co2_ppm"`
	}
	_ = json.Unmarshal(res.Content, &summary)
	if summary.TempF == nil || summary.TempF.Count != 3 {
		t.Fatalf("expected 3 temp readings, got %+v", summary.TempF)
	}
	if summary.TempF.Min != 62 || summary.TempF.Max != 65 {
		t.Errorf("temp range wrong: %+v", summary.TempF)
	}
	if summary.Humidity == nil || summary.Humidity.Count != 3 {
		t.Errorf("humidity count wrong: %+v", summary.Humidity)
	}
}

func TestLogSensorTempCrossfill(t *testing.T) {
	defer withTempDB(t)()
	r, _ := handleBatchStart(context.Background(), json.RawMessage(`{"kind":"bag"}`))
	var br struct{ BatchID int64 `json:"batch_id"` }
	_ = json.Unmarshal(r.Content, &br)

	// Send only Celsius — the handler should cross-fill F so summaries work
	res, _ := handleLogSensor(context.Background(), json.RawMessage(`{
		"batch_id":`+jsonNum(br.BatchID)+`,"temp_c":18.0
	}`))
	if res.IsError {
		t.Fatalf("log: %s", res.ErrorText)
	}
	sumRes, _ := handleSensorSummary(context.Background(), json.RawMessage(`{"batch_id":`+jsonNum(br.BatchID)+`}`))
	var summary struct {
		TempF *sensorAgg `json:"temp_f"`
	}
	_ = json.Unmarshal(sumRes.Content, &summary)
	if summary.TempF == nil {
		t.Fatal("expected temp_f cross-filled from temp_c")
	}
	// 18°C should be 64.4°F
	if summary.TempF.Avg < 64 || summary.TempF.Avg > 65 {
		t.Errorf("temp_c -> temp_f conversion off: %v", summary.TempF.Avg)
	}
}

func TestSyncPlatformRequiresToken(t *testing.T) {
	defer withTempDB(t)()
	t.Setenv(EnvSyncToken, "")
	res, _ := handleSyncPlatform(context.Background(), json.RawMessage(`{}`))
	if !res.IsError {
		t.Fatal("expected error when token unset")
	}
}

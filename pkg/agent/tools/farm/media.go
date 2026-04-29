// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.list_photos",
		Description: "List photo events with their archived paths. Optional batch_id filter. " +
			"Returns event_id, batch_id, ts, path, size - useful for building galleries or " +
			"verifying which batches have photo documentation.",
		Schema:   json.RawMessage(SchemaListPhotos),
		Mutating: false,
		Handler:  handleListPhotos,
	})
	registry.Register(&registry.Tool{
		Name: "farm.attach_photo",
		Description: "Capture a photo and attach it to a batch as a 'photo' event. " +
			"On macOS the screen is captured via screencapture; pass mode='selection' for click-and-drag, " +
			"mode='window' for window picker, or path=... if you already have an image. The file is " +
			"copied/saved into the photos archive directory and the path is stored on the event.",
		Schema:   json.RawMessage(SchemaAttachPhoto),
		Mutating: false,
		Handler:  handleAttachPhoto,
	})
	registry.Register(&registry.Tool{
		Name: "farm.log_sensor",
		Description: "Record a sensor reading against a batch (temperature, humidity, CO2, light). " +
			"Stored as a 'sensor' event with structured payload. All fields optional; pass whatever the " +
			"probe gave. ts defaults to now.",
		Schema:   json.RawMessage(SchemaLogSensor),
		Mutating: false,
		Handler:  handleLogSensor,
	})
	registry.Register(&registry.Tool{
		Name: "farm.sensor_summary",
		Description: "Aggregate sensor readings (avg/min/max) for a batch over an optional window. " +
			"Useful for verifying fruiting room conditions held within target ranges.",
		Schema:   json.RawMessage(SchemaSensorSummary),
		Mutating: false,
		Handler:  handleSensorSummary,
	})
}

const SchemaListPhotos = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1,"description":"Optional - omit to list across all batches"},
    "limit":    {"type":"integer","minimum":1,"maximum":500,"default":50}
  },
  "additionalProperties":false
}`

type listPhotosArgs struct {
	BatchID int64 `json:"batch_id"`
	Limit   int   `json:"limit"`
}

type photoEntry struct {
	EventID int64  `json:"event_id"`
	BatchID int64  `json:"batch_id"`
	TS      string `json:"ts"`
	Notes   string `json:"notes,omitempty"`
	Path    string `json:"path,omitempty"`
	Size    int64  `json:"size,omitempty"`
	Mode    string `json:"mode,omitempty"`
}

func handleListPhotos(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args listPhotosArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	if args.Limit <= 0 || args.Limit > 500 {
		args.Limit = 50
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	q := `SELECT id, batch_id, ts, COALESCE(notes,''), COALESCE(payload,'')
	      FROM events WHERE event_type='photo'`
	var qargs []any
	if args.BatchID != 0 {
		q += " AND batch_id = ?"
		qargs = append(qargs, args.BatchID)
	}
	q += " ORDER BY ts DESC LIMIT ?"
	qargs = append(qargs, args.Limit)

	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return errResult(err), nil
	}
	defer rows.Close()

	out := make([]photoEntry, 0, args.Limit)
	for rows.Next() {
		var entry photoEntry
		var payload string
		if err := rows.Scan(&entry.EventID, &entry.BatchID, &entry.TS, &entry.Notes, &payload); err != nil {
			return errResult(err), nil
		}
		if payload != "" {
			var p map[string]any
			if err := json.Unmarshal([]byte(payload), &p); err == nil {
				if s, ok := p["path"].(string); ok {
					entry.Path = s
				}
				if v, ok := p["size"].(float64); ok {
					entry.Size = int64(v)
				}
				if s, ok := p["mode"].(string); ok {
					entry.Mode = s
				}
			}
		}
		out = append(out, entry)
	}
	body, _ := json.Marshal(map[string]any{"photos": out, "count": len(out)})
	return registry.Result{Content: body}, nil
}

const SchemaAttachPhoto = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1},
    "mode":     {"type":"string","enum":["screen","selection","window","clipboard","none"],"default":"selection",
                 "description":"How to capture: screen=full screen, selection=click and drag, window=pick a window, clipboard=read NSPasteboard image, none=use existing path"},
    "path":     {"type":"string","description":"If mode=none, an existing image path to attach. Otherwise where to save the new capture."},
    "notes":    {"type":"string"}
  },
  "required":["batch_id"],
  "additionalProperties":false
}`

const SchemaLogSensor = `{
  "type": "object",
  "properties": {
    "batch_id":  {"type":"integer","minimum":1},
    "temp_f":    {"type":"number","description":"Temperature in Fahrenheit"},
    "temp_c":    {"type":"number","description":"Temperature in Celsius (alternative to temp_f)"},
    "humidity":  {"type":"number","minimum":0,"maximum":100,"description":"Relative humidity %"},
    "co2_ppm":   {"type":"number","minimum":0,"description":"CO2 in parts per million"},
    "light_lux": {"type":"number","minimum":0},
    "source":    {"type":"string","description":"Sensor / probe name, e.g. 'sensorpush-A1', 'manual'"},
    "notes":     {"type":"string"},
    "ts":        {"type":"string","description":"ISO8601; defaults to now"}
  },
  "required":["batch_id"],
  "additionalProperties":false
}`

const SchemaSensorSummary = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1,"description":"Optional - omit to summarize across all batches"},
    "since":    {"type":"string","description":"ISO8601 - only include readings from this date onward"}
  },
  "additionalProperties":false
}`

// ----- attach_photo -----

const photosSubdir = "photos"

type attachPhotoArgs struct {
	BatchID int64  `json:"batch_id"`
	Mode    string `json:"mode"`
	Path    string `json:"path"`
	Notes   string `json:"notes"`
}

func handleAttachPhoto(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args attachPhotoArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 {
		return errResult(fmt.Errorf("batch_id required")), nil
	}
	if args.Mode == "" {
		args.Mode = "selection"
	}

	finalPath, err := capturePhoto(ctx, args)
	if err != nil {
		return errResult(err), nil
	}

	stat, err := os.Stat(finalPath)
	if err != nil {
		return errResult(fmt.Errorf("photo file not found after capture: %s", finalPath)), nil
	}

	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	payloadObj := map[string]any{
		"path":     finalPath,
		"size":     stat.Size(),
		"mode":     args.Mode,
		"captured": time.Now().UTC().Format(time.RFC3339),
	}
	payloadJSON, _ := json.Marshal(payloadObj)
	notes := args.Notes
	if notes == "" {
		notes = fmt.Sprintf("photo (%dKB)", stat.Size()/1024)
	}
	res, err := conn.ExecContext(ctx, `
		INSERT INTO events (batch_id, event_type, ts, notes, payload)
		VALUES (?, 'photo', ?, ?, ?)
	`, args.BatchID, time.Now().UTC().Format(time.RFC3339), notes, string(payloadJSON))
	if err != nil {
		return errResult(err), nil
	}
	id, _ := res.LastInsertId()
	body, _ := json.Marshal(map[string]any{
		"event_id": id,
		"batch_id": args.BatchID,
		"path":     finalPath,
		"size":     stat.Size(),
	})
	return registry.Result{Content: body}, nil
}

func capturePhoto(ctx context.Context, args attachPhotoArgs) (string, error) {
	if args.Mode == "none" {
		if args.Path == "" {
			return "", fmt.Errorf("mode=none requires path")
		}
		// Copy into archive so the original can move/delete without breaking the log
		return archiveExisting(args.BatchID, args.Path)
	}

	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("automated capture only on darwin (mode=%s); use mode='none' with explicit path on other platforms", args.Mode)
	}

	dest := args.Path
	if dest == "" {
		dest = newPhotoPath(args.BatchID)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}

	var cmd *exec.Cmd
	switch args.Mode {
	case "screen":
		cmd = exec.CommandContext(ctx, "screencapture", "-x", dest)
	case "selection":
		cmd = exec.CommandContext(ctx, "screencapture", "-i", dest)
	case "window":
		cmd = exec.CommandContext(ctx, "screencapture", "-iW", dest)
	case "clipboard":
		// pull NSPasteboard PNG via osascript+shell - simplest reliable path
		cmd = exec.CommandContext(ctx, "osascript", "-e",
			fmt.Sprintf(`set theFile to POSIX file %q
do shell script "pngpaste " & quoted form of POSIX path of theFile`, dest))
	default:
		return "", fmt.Errorf("unknown mode: %s", args.Mode)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("capture failed (%s): %s", err, string(out))
	}
	if _, err := os.Stat(dest); err != nil {
		// User cancelled the selection / window picker
		return "", fmt.Errorf("no image captured (likely cancelled)")
	}
	return dest, nil
}

func archiveExisting(batchID int64, src string) (string, error) {
	srcAbs, err := filepath.Abs(src)
	if err != nil {
		return "", err
	}
	in, err := os.Open(srcAbs)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", srcAbs, err)
	}
	defer in.Close()
	dest := newPhotoPath(batchID)
	if ext := filepath.Ext(srcAbs); ext != "" && ext != ".png" {
		dest = dest[:len(dest)-len(filepath.Ext(dest))] + ext
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	out, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer out.Close()
	if _, err := copyAll(out, in); err != nil {
		return "", err
	}
	return dest, nil
}

func copyAll(dst, src interface{ Read(p []byte) (int, error) }) (int64, error) {
	w := dst.(interface{ Write(p []byte) (int, error) })
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return total, werr
			}
			total += int64(n)
		}
		if err != nil {
			if err.Error() == "EOF" {
				return total, nil
			}
			return total, err
		}
	}
}

func newPhotoPath(batchID int64) string {
	base, _ := os.UserConfigDir()
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	name := fmt.Sprintf("batch%d-%s.png", batchID, stamp)
	return filepath.Join(base, configDirName, photosSubdir, name)
}

// ----- log_sensor -----

type logSensorArgs struct {
	BatchID  int64    `json:"batch_id"`
	TempF    *float64 `json:"temp_f"`
	TempC    *float64 `json:"temp_c"`
	Humidity *float64 `json:"humidity"`
	CO2PPM   *float64 `json:"co2_ppm"`
	LightLux *float64 `json:"light_lux"`
	Source   string   `json:"source"`
	Notes    string   `json:"notes"`
	TS       string   `json:"ts"`
}

func handleLogSensor(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args logSensorArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 {
		return errResult(fmt.Errorf("batch_id required")), nil
	}
	// Cross-fill temp_c <-> temp_f so queries can rely on temp_f being present
	if args.TempC != nil && args.TempF == nil {
		v := *args.TempC*9/5 + 32
		args.TempF = &v
	}
	if args.TempF != nil && args.TempC == nil {
		v := (*args.TempF - 32) * 5 / 9
		args.TempC = &v
	}

	payload := map[string]any{}
	if args.TempF != nil {
		payload["temp_f"] = *args.TempF
	}
	if args.TempC != nil {
		payload["temp_c"] = *args.TempC
	}
	if args.Humidity != nil {
		payload["humidity"] = *args.Humidity
	}
	if args.CO2PPM != nil {
		payload["co2_ppm"] = *args.CO2PPM
	}
	if args.LightLux != nil {
		payload["light_lux"] = *args.LightLux
	}
	if args.Source != "" {
		payload["source"] = args.Source
	}
	payloadJSON, _ := json.Marshal(payload)

	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	res, err := conn.ExecContext(ctx, `
		INSERT INTO events (batch_id, event_type, ts, notes, payload)
		VALUES (?, 'sensor', ?, ?, ?)
	`, args.BatchID, nowOr(args.TS), args.Notes, string(payloadJSON))
	if err != nil {
		return errResult(err), nil
	}
	id, _ := res.LastInsertId()
	body, _ := json.Marshal(map[string]any{
		"event_id": id,
		"batch_id": args.BatchID,
		"reading":  payload,
	})
	return registry.Result{Content: body}, nil
}

// ----- sensor_summary -----

type sensorSummaryArgs struct {
	BatchID int64  `json:"batch_id"`
	Since   string `json:"since"`
}

type sensorAgg struct {
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	Count int     `json:"count"`
}

func handleSensorSummary(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args sensorSummaryArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	q := `SELECT payload FROM events WHERE event_type='sensor'`
	var qargs []any
	if args.BatchID != 0 {
		q += " AND batch_id = ?"
		qargs = append(qargs, args.BatchID)
	}
	if args.Since != "" {
		q += " AND ts >= ?"
		qargs = append(qargs, args.Since)
	}
	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return errResult(err), nil
	}
	defer rows.Close()

	tempF := newAggBuilder()
	humidity := newAggBuilder()
	co2 := newAggBuilder()
	lux := newAggBuilder()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return errResult(err), nil
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(p), &m); err != nil {
			continue
		}
		if v, ok := m["temp_f"].(float64); ok {
			tempF.add(v)
		}
		if v, ok := m["humidity"].(float64); ok {
			humidity.add(v)
		}
		if v, ok := m["co2_ppm"].(float64); ok {
			co2.add(v)
		}
		if v, ok := m["light_lux"].(float64); ok {
			lux.add(v)
		}
	}

	body, _ := json.Marshal(map[string]any{
		"batch_id":  args.BatchID,
		"since":     args.Since,
		"temp_f":    tempF.result(),
		"humidity":  humidity.result(),
		"co2_ppm":   co2.result(),
		"light_lux": lux.result(),
	})
	return registry.Result{Content: body}, nil
}

type aggBuilder struct {
	count int
	sum   float64
	min   float64
	max   float64
}

func newAggBuilder() *aggBuilder { return &aggBuilder{} }

func (a *aggBuilder) add(v float64) {
	if a.count == 0 {
		a.min = v
		a.max = v
	} else {
		if v < a.min {
			a.min = v
		}
		if v > a.max {
			a.max = v
		}
	}
	a.sum += v
	a.count++
}

func (a *aggBuilder) result() *sensorAgg {
	if a.count == 0 {
		return nil
	}
	return &sensorAgg{Min: a.min, Max: a.max, Avg: a.sum / float64(a.count), Count: a.count}
}

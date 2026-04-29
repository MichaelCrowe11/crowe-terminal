// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0
//
// crowe-farm-sensorpush is a long-running poller that pulls readings
// from the SensorPush API and feeds them into the cultivation log via
// farm.log_sensor.
//
// Mapping: a JSON file (default ~/Library/Application Support/crowe-terminal/sensorpush-map.json)
// associates SensorPush device names/IDs with active batch IDs:
//
//   {
//     "interval_seconds": 300,
//     "mappings": [
//       {"sensor": "SensorPush HT.w 12345", "batch_id": 14, "source": "fruiting-room-A"},
//       {"sensor": "SensorPush HT.w 67890", "batch_id": 22, "source": "fruiting-room-B"}
//     ]
//   }
//
// Auth: SENSORPUSH_EMAIL + SENSORPUSH_PASSWORD env vars. The poller does
// the AWS Cognito-style auth flow (oauth/authorize -> oauth/accesstoken)
// once at startup and refreshes when the token expires.
//
// Run:
//
//   SENSORPUSH_EMAIL=... SENSORPUSH_PASSWORD=... crowe-farm-sensorpush
//
// Or as a launchd / systemd job for continuous logging.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	farm "github.com/wavetermdev/waveterm/pkg/agent/tools/farm"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	apiBase = "https://api.sensorpush.com/api/v1"
)

type mapping struct {
	Sensor  string `json:"sensor"`
	BatchID int64  `json:"batch_id"`
	Source  string `json:"source,omitempty"`
}

type config struct {
	IntervalSeconds int       `json:"interval_seconds"`
	Mappings        []mapping `json:"mappings"`
}

func defaultMapPath() string {
	base, _ := os.UserConfigDir()
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "crowe-terminal", "sensorpush-map.json")
}

type client struct {
	httpc       *http.Client
	authzCode   string
	accessToken string
	expiresAt   time.Time
	email       string
	password    string
	mu          sync.Mutex
}

func newClient(email, password string) *client {
	return &client{
		httpc:    &http.Client{Timeout: 30 * time.Second},
		email:    email,
		password: password,
	}
}

func (c *client) authorize(ctx context.Context) error {
	body, err := json.Marshal(map[string]string{
		"email":    c.email,
		"password": c.password,
	})
	if err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", apiBase+"/oauth/authorize", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("authorize: HTTP %d: %s", resp.StatusCode, string(b))
	}
	var out struct {
		Authorization string `json:"authorization"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	c.authzCode = out.Authorization
	return nil
}

func (c *client) accessTokenRequest(ctx context.Context) error {
	body, _ := json.Marshal(map[string]string{
		"authorization": c.authzCode,
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", apiBase+"/oauth/accesstoken", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("accesstoken: HTTP %d: %s", resp.StatusCode, string(b))
	}
	var out struct {
		Accesstoken string `json:"accesstoken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	c.accessToken = out.Accesstoken
	// SensorPush tokens last ~30 min; refresh slightly before.
	c.expiresAt = time.Now().Add(25 * time.Minute)
	return nil
}

func (c *client) ensureToken(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accessToken != "" && time.Now().Before(c.expiresAt) {
		return nil
	}
	if err := c.authorize(ctx); err != nil {
		return err
	}
	return c.accessTokenRequest(ctx)
}

type sensorMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (c *client) listSensors(ctx context.Context) (map[string]sensorMeta, error) {
	if err := c.ensureToken(ctx); err != nil {
		return nil, err
	}
	body := bytes.NewReader([]byte(`{}`))
	req, _ := http.NewRequestWithContext(ctx, "POST", apiBase+"/devices/sensors", body)
	req.Header.Set("Authorization", c.accessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sensors: HTTP %d: %s", resp.StatusCode, string(b))
	}
	var out map[string]sensorMeta
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

type sample struct {
	Time        string  `json:"observed"`
	Temperature float64 `json:"temperature"` // SensorPush returns Fahrenheit
	Humidity    float64 `json:"humidity"`
}

func (c *client) latestSample(ctx context.Context, sensorID string) (*sample, error) {
	if err := c.ensureToken(ctx); err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{
		"limit":   1,
		"sensors": []string{sensorID},
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", apiBase+"/samples", bytes.NewReader(body))
	req.Header.Set("Authorization", c.accessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("samples: HTTP %d: %s", resp.StatusCode, string(b))
	}
	var out struct {
		Sensors map[string][]sample `json:"sensors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	rows, ok := out.Sensors[sensorID]
	if !ok || len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// resolveSensorID looks up a SensorPush device by either id or display name.
func resolveSensorID(catalog map[string]sensorMeta, query string) string {
	if _, ok := catalog[query]; ok {
		return query
	}
	for id, meta := range catalog {
		if meta.Name == query {
			return id
		}
	}
	return ""
}

func logSampleToFarm(ctx context.Context, batchID int64, source string, s *sample) error {
	args := map[string]any{
		"batch_id": batchID,
		"temp_f":   s.Temperature,
		"humidity": s.Humidity,
		"source":   source,
		"ts":       s.Time,
	}
	body, _ := json.Marshal(args)
	res, err := registry.Default().Call(ctx, registry.CallRequest{
		Name:      "farm.log_sensor",
		Arguments: body,
	})
	if err != nil && !res.IsError {
		return err
	}
	if res.IsError {
		return fmt.Errorf("%s", res.ErrorText)
	}
	return nil
}

func main() {
	mapPath := flag.String("map", defaultMapPath(), "Path to JSON mapping file")
	once := flag.Bool("once", false, "Poll once and exit (instead of looping)")
	flag.Parse()

	email := os.Getenv("SENSORPUSH_EMAIL")
	password := os.Getenv("SENSORPUSH_PASSWORD")
	if email == "" || password == "" {
		log.Fatal("SENSORPUSH_EMAIL and SENSORPUSH_PASSWORD env vars required")
	}

	cfg, err := loadConfig(*mapPath)
	if err != nil {
		log.Fatalf("load mapping %s: %v", *mapPath, err)
	}
	if len(cfg.Mappings) == 0 {
		log.Fatalf("no mappings in %s - add { sensor, batch_id } entries", *mapPath)
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 300
	}
	log.Printf("loaded %d mappings, polling every %ds", len(cfg.Mappings), cfg.IntervalSeconds)
	log.Printf("farm DB: %s", farm.DBPathForTesting())

	c := newClient(email, password)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Resolve sensor IDs once at startup
	if err := c.ensureToken(ctx); err != nil {
		log.Fatalf("auth: %v", err)
	}
	catalog, err := c.listSensors(ctx)
	if err != nil {
		log.Fatalf("list sensors: %v", err)
	}
	log.Printf("found %d sensors on the SensorPush account", len(catalog))
	resolved := make([]struct {
		mapping
		ID string
	}, 0, len(cfg.Mappings))
	for _, m := range cfg.Mappings {
		id := resolveSensorID(catalog, m.Sensor)
		if id == "" {
			log.Printf("warning: sensor %q not found, skipping", m.Sensor)
			continue
		}
		resolved = append(resolved, struct {
			mapping
			ID string
		}{m, id})
		log.Printf("mapped: %s -> batch %d", m.Sensor, m.BatchID)
	}
	if len(resolved) == 0 {
		log.Fatal("no resolvable mappings; nothing to poll")
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	pollOnce := func() {
		for _, r := range resolved {
			s, err := c.latestSample(ctx, r.ID)
			if err != nil {
				log.Printf("sample %s: %v", r.Sensor, err)
				continue
			}
			if s == nil {
				log.Printf("sample %s: no data", r.Sensor)
				continue
			}
			source := r.Source
			if source == "" {
				source = r.Sensor
			}
			if err := logSampleToFarm(ctx, r.BatchID, source, s); err != nil {
				log.Printf("log batch %d: %v", r.BatchID, err)
				continue
			}
			log.Printf("batch %d: %.1f°F %.1f%% (%s)", r.BatchID, s.Temperature, s.Humidity, source)
		}
	}

	pollOnce()
	if *once {
		return
	}
	tick := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			log.Println("shutting down")
			return
		case <-tick.C:
			pollOnce()
		}
	}
}

func loadConfig(path string) (*config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("mapping file %s not found - create it with { interval_seconds, mappings: [{sensor, batch_id, source}] }", path)
		}
		return nil, err
	}
	var c config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &c, nil
}

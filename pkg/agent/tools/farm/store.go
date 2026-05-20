// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package farm exposes cultivation-operations logging as agent tools.
//
// Storage is a local SQLite file at the user's config dir. No network
// dependency. The schema is intentionally narrow: three tables capture
// the chain of custody from substrate through fruiting through harvest.
//
//	batches    started life of a thing (grain jar, fruiting bag, etc.)
//	events     anything that happened to a batch (transfer, contam, FAE)
//	harvests   weights pulled off a fruiting batch
//
// A future sync tool can push these to the Crowe Logic AI Platform; the
// local DB is the source of truth.
package farm

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

const (
	configDirName = "crowe-terminal"
	dbFileName    = "farmlog.db"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                  -- grain | sawdust | bag | bulk | agar | other
  strain       TEXT,
  substrate    TEXT,                           -- recipe / source
  weight_kg    REAL,
  started_at   TEXT NOT NULL,                  -- ISO8601
  technician   TEXT,
  parent_id    INTEGER,                        -- lineage: this batch came from another batch
  state        TEXT NOT NULL DEFAULT 'active', -- active | culled | finished
  notes        TEXT,
  FOREIGN KEY (parent_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS idx_batches_strain ON batches(strain);
CREATE INDEX IF NOT EXISTS idx_batches_state  ON batches(state);
CREATE INDEX IF NOT EXISTS idx_batches_started ON batches(started_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER NOT NULL,
  event_type  TEXT NOT NULL,    -- inoculate|transfer|fruiting_init|contam|fae|water|cull|note
  ts          TEXT NOT NULL,    -- ISO8601
  notes       TEXT,
  payload     TEXT,             -- arbitrary JSON
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_batch ON events(batch_id);
CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type  ON events(event_type);

CREATE TABLE IF NOT EXISTS harvests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER NOT NULL,
  ts          TEXT NOT NULL,
  weight_kg   REAL NOT NULL,
  quality     TEXT,             -- A | B | C | cull
  flush_num   INTEGER,          -- 1, 2, 3...
  notes       TEXT,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_harvests_batch ON harvests(batch_id);
CREATE INDEX IF NOT EXISTS idx_harvests_ts    ON harvests(ts);
`

var (
	dbLock sync.Mutex
	db     *sql.DB
)

// EnvFarmDBPath, when set, overrides the resolved DB path. Used by tests
// (the real os.UserConfigDir is per-OS and not redirectable via env on
// macOS), and available as an escape hatch for users who want their farm
// log somewhere specific.
const EnvFarmDBPath = "CROWE_FARM_DB_PATH"

func configDir() string {
	if override := os.Getenv(EnvFarmDBPath); override != "" {
		return filepath.Dir(override)
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, configDirName)
}

func dbPath() (string, error) {
	if override := os.Getenv(EnvFarmDBPath); override != "" {
		dir := filepath.Dir(override)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", fmt.Errorf("mkdir %s: %w", dir, err)
		}
		return override, nil
	}
	dir := configDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return filepath.Join(dir, dbFileName), nil
}

// getDB lazily opens the SQLite database and applies the schema. All tool
// handlers call this; the cost after first call is one map lookup.
func getDB() (*sql.DB, error) {
	dbLock.Lock()
	defer dbLock.Unlock()
	if db != nil {
		return db, nil
	}
	path, err := dbPath()
	if err != nil {
		return nil, err
	}
	conn, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open farmlog: %w", err)
	}
	if _, err := conn.Exec(schemaSQL); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	db = conn
	return db, nil
}

// DBPathForTesting exposes the path for test harnesses; production code
// should call getDB() directly.
func DBPathForTesting() string {
	p, _ := dbPath()
	return p
}

// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package livewatch watches the on-disk files that open Crowe Code blocks are
// bound to and republishes external changes as the same crowecode:filechange
// WPS event the agent's editor.* tools emit. This closes the gap left by the
// in-process publish path: edits made OUTSIDE the app (vim, git checkout,
// formatters) now live-reload open blocks too, reusing the frontend's existing
// reconcile (clean -> reload, dirty -> conflict guard).
//
// We watch the containing DIRECTORY rather than the file node, because most
// editors save via write-temp-then-rename, which detaches an inode-level file
// watch. Directory events are filtered down to the ref-counted set of files we
// actually care about, so a busy project dir produces no extra published work.
package livewatch

import (
	"errors"
	"log"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// OpExternal is the Op value carried by events this watcher publishes, to
// distinguish a disk change observed via fsnotify from the agent's own
// write/edit tool calls.
const OpExternal = "external"

// relevantOps are the fsnotify operations that mean "the bytes may have
// changed". Chmod is ignored; Remove is skipped because a reload of a deleted
// file would only surface a read error.
const relevantOps = fsnotify.Write | fsnotify.Create | fsnotify.Rename

type watcher struct {
	mu       sync.Mutex
	fsw      *fsnotify.Watcher
	fileRefs map[string]int // abs file path -> open-block refcount
	dirRefs  map[string]int // dir path -> count of watched files within it
}

var (
	inst *watcher
	once sync.Once
)

func get() *watcher {
	once.Do(func() {
		inst = &watcher{
			fileRefs: make(map[string]int),
			dirRefs:  make(map[string]int),
		}
	})
	return inst
}

// ensureStarted lazily creates the fsnotify watcher and its event loop on the
// first Watch call, so a session that never opens a Crowe Code block pays
// nothing. Caller must hold w.mu.
func (w *watcher) ensureStarted() bool {
	if w.fsw != nil {
		return true
	}
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("livewatch: cannot create fsnotify watcher: %v", err)
		return false
	}
	w.fsw = fsw
	go w.loop(fsw)
	return true
}

func (w *watcher) loop(fsw *fsnotify.Watcher) {
	defer func() {
		panichandler.PanicHandler("livewatch:loop", recover())
	}()
	for {
		select {
		case event, ok := <-fsw.Events:
			if !ok {
				return
			}
			w.handleEvent(event)
		case err, ok := <-fsw.Errors:
			if !ok {
				return
			}
			log.Printf("livewatch: watcher error: %v", err)
		}
	}
}

func (w *watcher) handleEvent(event fsnotify.Event) {
	if event.Op&relevantOps == 0 {
		return
	}
	abs := filepath.Clean(event.Name)
	w.mu.Lock()
	watched := w.fileRefs[abs] > 0
	w.mu.Unlock()
	if !watched {
		return
	}
	publish(abs)
}

func publish(abs string) {
	go wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_CroweCodeFileChange,
		Scopes: []string{abs},
		Data:   wps.CroweCodeFileChangeData{Path: abs, Op: OpExternal, Origin: wps.CroweCodeOriginExternal},
	})
}

// Watch starts (or ref-increments) a watch on the directory containing path,
// so external changes to path publish a crowecode:filechange event. Safe to
// call repeatedly for the same path; balance each call with Unwatch.
func Watch(path string) {
	if path == "" {
		return
	}
	abs := filepath.Clean(path)
	dir := filepath.Dir(abs)
	w := get()
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.ensureStarted() {
		return
	}
	w.fileRefs[abs]++
	if w.fileRefs[abs] == 1 {
		w.dirRefs[dir]++
	}
	// Always (re)assert the directory watch rather than only on the first ref.
	// fsnotify treats Add of an already-watched path as a no-op, so this is
	// cheap, and it self-heals a desync where an overlapping Unwatch (e.g. a
	// dev HMR remount churning watch/unwatch across two component instances)
	// removed the dir while a block still references a file in it.
	if err := w.fsw.Add(dir); err != nil {
		log.Printf("livewatch: failed to watch dir %s: %v", dir, err)
	}
}

// Unwatch ref-decrements path; when the last open block releases it the file
// is dropped, and when a directory has no watched files left its fsnotify
// registration is removed. Unbalanced/unknown paths are ignored.
func Unwatch(path string) {
	if path == "" {
		return
	}
	abs := filepath.Clean(path)
	dir := filepath.Dir(abs)
	w := get()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.fileRefs[abs] == 0 {
		return
	}
	w.fileRefs[abs]--
	if w.fileRefs[abs] > 0 {
		return
	}
	delete(w.fileRefs, abs)
	w.dirRefs[dir]--
	if w.dirRefs[dir] <= 0 {
		delete(w.dirRefs, dir)
		if w.fsw != nil {
			// A "non-existent watch" here is benign: the directory watch may
			// already be gone (self-heal Add/Remove interleaving). Only surface
			// genuinely unexpected removal failures.
			if err := w.fsw.Remove(dir); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
				log.Printf("livewatch: failed to unwatch dir %s: %v", dir, err)
			}
		}
	}
}

// WatchCount reports how many distinct files are currently watched. Exposed
// for tests and diagnostics.
func WatchCount() int {
	w := get()
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.fileRefs)
}

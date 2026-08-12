// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package editor

import (
	"context"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/jj"
)

// autoRestorePoint records the operation a caller can rewind to, taken
// immediately before a mutating write.
//
// This used to depend on the model choosing to call vcs.checkpoint first,
// which made "the agent's edits are reversible" a hope rather than a
// property of the edit. Taking the restore point inside the write makes it
// the latter: every mutating editor tool in a tracked workspace hands back
// an id that undoes exactly that write.
//
// Best effort on purpose. An untracked directory, a missing jj, or a jj that
// errors must never block an edit the user asked for, so every failure path
// returns the empty string and the caller omits the field rather than
// reporting a restore point that does not exist.
func autoRestorePoint(ctx context.Context, abs string) string {
	if !jj.Available() {
		return ""
	}
	dir, err := jj.ResolveDir(filepath.Dir(abs))
	if err != nil {
		return ""
	}
	root, err := jj.WorkspaceRoot(ctx, dir)
	if err != nil {
		return ""
	}
	// CheckpointID runs `jj status` first, which forces a working-copy
	// snapshot. Called before the write, the id it returns therefore names
	// the state without this edit, and restoring to it undoes just this one.
	id, err := jj.CheckpointID(ctx, root)
	if err != nil {
		return ""
	}
	return id
}

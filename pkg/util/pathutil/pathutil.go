// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package pathutil resolves executables the way a user expects, not the way a
// GUI-launched process sees the world.
//
// A macOS app started from Finder, the Dock, or Spotlight inherits
// /usr/bin:/bin:/usr/sbin:/sbin and nothing else. Terminal blocks are immune
// because they spawn a real login shell that sources the user's rc files, but
// every exec.LookPath on the Go side is not: homebrew, cargo, nix, and
// ~/.local/bin are all invisible. The symptom is always the same and always
// wrong, "command not found" for a tool the user can run in any other terminal.
package pathutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// UserBinDirs are the directories a login shell would almost certainly have
// added. $HOME is expanded at lookup time. Order matters: homebrew's arm64
// prefix comes first because that is where the overwhelming majority of these
// tools actually live on Apple silicon.
var UserBinDirs = []string{
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/local/sbin",
	"/home/linuxbrew/.linuxbrew/bin",
	"/nix/var/nix/profiles/default/bin",
	"$HOME/.cargo/bin",
	"$HOME/.local/bin",
	"$HOME/.nix-profile/bin",
	"$HOME/go/bin",
}

func expand(dir string) string {
	if !strings.HasPrefix(dir, "$HOME") {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, strings.TrimPrefix(dir, "$HOME"))
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

// ExtraDirs returns the user bin directories that exist on this machine and are
// not already on PATH.
func ExtraDirs() []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	onPath := map[string]bool{}
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p != "" {
			onPath[filepath.Clean(p)] = true
		}
	}
	extra := []string{}
	for _, raw := range UserBinDirs {
		dir := expand(raw)
		if dir == "" || onPath[filepath.Clean(dir)] {
			continue
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			extra = append(extra, dir)
			onPath[filepath.Clean(dir)] = true
		}
	}
	return extra
}

// AugmentedPATH is PATH with the missing user bin directories appended. They go
// last on purpose: an explicitly configured PATH entry must keep winning, so
// this can only ever make a previously failing lookup succeed, never redirect
// one that already resolved.
func AugmentedPATH() string {
	current := os.Getenv("PATH")
	extra := ExtraDirs()
	if len(extra) == 0 {
		return current
	}
	if current == "" {
		return strings.Join(extra, string(os.PathListSeparator))
	}
	return current + string(os.PathListSeparator) + strings.Join(extra, string(os.PathListSeparator))
}

// EnvWithPATH returns env with its PATH entry replaced by AugmentedPATH. Any
// pre-existing PATH assignment is dropped so the child sees exactly one.
func EnvWithPATH(env []string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "PATH="+AugmentedPATH())
}

// LookPath resolves name against PATH first, then against the user bin
// directories. It returns "" when the binary genuinely is not installed.
func LookPath(name string) string {
	if name == "" {
		return ""
	}
	// Windows has no user bin fallback here and no execute bit at all: Go maps
	// every regular file to 0666, so the permission test below can never pass,
	// and "git" only resolves to git.exe through PATHEXT. exec.LookPath already
	// knows both rules, so on Windows it stays the whole answer.
	if runtime.GOOS == "windows" {
		p, err := exec.LookPath(name)
		if err != nil {
			return ""
		}
		return p
	}
	// An explicit path is the caller's decision; do not second-guess it.
	if strings.ContainsRune(name, os.PathSeparator) {
		if isExecutableFile(name) {
			return name
		}
		return ""
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	for _, dir := range ExtraDirs() {
		candidate := filepath.Join(dir, name)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}

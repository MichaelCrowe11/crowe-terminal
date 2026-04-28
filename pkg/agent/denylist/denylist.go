// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package denylist holds the patterns that ALWAYS require user
// confirmation, even if the user has tried to allowlist them. The
// allowlist consults this package; exec_safe consults this package.
// Single source of truth so a "safe" subprocess can never run a
// mutating command via a tool.
package denylist

import (
	"regexp"
	"strings"
)

var mutatingVerbs = []string{
	"rm", "rmdir", "mv", "cp",
	"chmod", "chown", "chgrp",
	"sudo", "doas", "su",
	"dd", "mkfs", "fdisk",
	"shutdown", "reboot", "poweroff", "halt",
	"systemctl", "launchctl", "service",
	"git push", "git reset --hard", "git clean", "git rm", "git rebase",
	"npm install", "npm uninstall", "npm publish", "npm ci",
	"pnpm add", "pnpm remove", "yarn add", "yarn remove",
	"pip install", "pip uninstall", "uv pip install", "uv add",
	"brew install", "brew uninstall", "brew upgrade",
	"apt install", "apt remove", "apt-get install", "apt-get remove",
	"docker rm", "docker rmi", "docker volume rm", "docker system prune",
	"kubectl delete", "kubectl apply", "kubectl create", "kubectl patch",
	"terraform apply", "terraform destroy",
	"make install", "make clean",
}

var redirectAppend = regexp.MustCompile(`(^|\s)(>>?|\|)\s*\S`)
var subshell = regexp.MustCompile(`\$\(|` + "`" + `[^` + "`" + `]`)
var pipeToShell = regexp.MustCompile(`\|\s*(sh|bash|zsh|fish|python|node)\b`)
var hereStringMutate = regexp.MustCompile(`>\s*[^&\s]`)

// IsMutating returns true if the command should never be run by
// exec_safe and should never be allowlistable. The check is
// intentionally conservative — false positives are fine; false
// negatives are not.
func IsMutating(command string) bool {
	c := strings.TrimSpace(command)
	if c == "" {
		return false
	}
	lc := strings.ToLower(c)
	for _, v := range mutatingVerbs {
		if matchesVerb(lc, v) {
			return true
		}
	}
	if pipeToShell.MatchString(lc) {
		return true
	}
	if subshell.MatchString(c) {
		return true
	}
	if hereStringMutate.MatchString(c) && !strings.HasPrefix(c, "echo ") {
		return true
	}
	if redirectAppend.MatchString(c) && !writesUnderTmp(c) {
		return true
	}
	return false
}

func matchesVerb(lc, verb string) bool {
	if !strings.Contains(lc, verb) {
		return false
	}
	for _, segment := range splitOnLogicalOps(lc) {
		s := strings.TrimSpace(segment)
		if s == verb || strings.HasPrefix(s, verb+" ") || strings.HasPrefix(s, verb+"\t") {
			return true
		}
	}
	return false
}

func splitOnLogicalOps(s string) []string {
	tmp := strings.ReplaceAll(s, "&&", "\x00")
	tmp = strings.ReplaceAll(tmp, "||", "\x00")
	tmp = strings.ReplaceAll(tmp, ";", "\x00")
	return strings.Split(tmp, "\x00")
}

func writesUnderTmp(c string) bool {
	idx := strings.Index(c, ">")
	if idx == -1 {
		return false
	}
	tail := strings.TrimLeft(c[idx:], ">| \t")
	return strings.HasPrefix(tail, "/tmp/") || strings.HasPrefix(tail, "/private/tmp/")
}

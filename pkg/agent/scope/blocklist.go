// pkg/agent/scope/blocklist.go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import "strings"

// SensitiveGlobs are paths no grant may ever authorize, on either transport.
// Mirrors the TS kernel blocklist. Each pattern is matched against the target
// with a single leading '/' stripped, so absolute and relative spellings are
// both covered. "Anywhere" patterns use a leading '**/'; root-anchored patterns
// (System) have no prefix.
//
// PRECONDITION: callers pass canonical paths. The resolver does not collapse
// "..", so canonicalization is the transport's responsibility.
var SensitiveGlobs = []string{
	"**/.ssh/id_*",
	"**/.ssh/*_rsa",
	"**/*.pem",
	"**/*.key",
	"**/.env",
	"**/.env.*",
	"**/.aws/credentials",
	"System/**",
	"**/etc/shadow",
	"**/etc/passwd",
}

// IsSensitivePath reports whether target matches any blocklist pattern.
func IsSensitivePath(target string) bool {
	normalized := strings.TrimPrefix(target, "/")
	for _, g := range SensitiveGlobs {
		if MatchGlob(g, normalized) {
			return true
		}
	}
	return false
}

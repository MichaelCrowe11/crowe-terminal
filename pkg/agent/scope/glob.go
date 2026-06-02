// pkg/agent/scope/glob.go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import "strings"

// MatchGlob is the Go mirror of the TS @crowe/code-capability matchGlob. It is
// the single glob dialect shared by both transports and MUST agree with the TS
// implementation on conformance/vectors.json. Segment-based globstar semantics,
// linear and backtracking-free (no regexp):
//
//	**  as a whole path segment: matches zero or more segments (crosses '/')
//	*   within a segment: matches zero or more non-'/' bytes
//	?   within a segment: matches exactly one non-'/' byte
//	else literal. Anchored: the whole pattern must match the whole target.
//
// A '**' that is not a whole segment (e.g. "a/**b") is treated as ordinary '*'
// wildcards within that one segment; it does not cross '/'.
func MatchGlob(pattern, target string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(target, "/"))
}

// isGlobstar reports whether a segment is the globstar token: two or more stars
// and nothing else ('**', '***', ... all collapse to globstar).
func isGlobstar(seg string) bool {
	if len(seg) < 2 {
		return false
	}
	for i := 0; i < len(seg); i++ {
		if seg[i] != '*' {
			return false
		}
	}
	return true
}

// matchSegments matches pattern segments against target segments, where a
// globstar segment matches zero or more target segments. Single backtrack
// pointer -> linear.
func matchSegments(pat, tgt []string) bool {
	p, t, star, mark := 0, 0, -1, 0
	for t < len(tgt) {
		switch {
		case p < len(pat) && isGlobstar(pat[p]):
			star = p
			mark = t
			p++
		case p < len(pat) && matchSegment(pat[p], tgt[t]):
			p++
			t++
		case star != -1:
			p = star + 1
			mark++
			t = mark
		default:
			return false
		}
	}
	for p < len(pat) && isGlobstar(pat[p]) {
		p++
	}
	return p == len(pat)
}

// matchSegment matches one pattern segment against one target segment. '*'
// matches zero or more bytes, '?' exactly one; neither crosses '/' (inputs are
// single segments). Single backtrack pointer -> linear.
func matchSegment(pat, tgt string) bool {
	p, t, star, mark := 0, 0, -1, 0
	for t < len(tgt) {
		switch {
		case p < len(pat) && pat[p] == '*':
			star = p
			mark = t
			p++
		case p < len(pat) && (pat[p] == '?' || pat[p] == tgt[t]):
			p++
			t++
		case star != -1:
			p = star + 1
			mark++
			t = mark
		default:
			return false
		}
	}
	for p < len(pat) && pat[p] == '*' {
		p++
	}
	return p == len(pat)
}

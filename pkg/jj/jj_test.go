// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package jj

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseOperations(t *testing.T) {
	out := "abc123\tsnapshot working copy\t2026-08-08 15:33:55\n" +
		"def456\tadd workspace 'default'\t2026-08-08 15:33:54\n" +
		"000000\t\t1970-01-01 00:00:00\n"
	ops := parseOperations(out)
	if len(ops) != 3 {
		t.Fatalf("got %d operations, want 3", len(ops))
	}
	if ops[0].ID != "abc123" || ops[0].Description != "snapshot working copy" {
		t.Fatalf("first operation parsed wrong: %+v", ops[0])
	}
	if ops[2].Description != "" {
		t.Fatalf("empty description should stay empty: %+v", ops[2])
	}
	if len(parseOperations("")) != 0 {
		t.Fatal("empty output should yield no operations")
	}
}

func TestParseOperationsFourFields(t *testing.T) {
	out := "abc123\tsnapshot working copy\t2026-08-09 07:05:33\t3 minutes ago\n"
	ops := parseOperations(out)
	if len(ops) != 1 || ops[0].TimeRel != "3 minutes ago" {
		t.Fatalf("relative time not parsed: %+v", ops)
	}
	if data, _ := json.Marshal(ops[0]); strings.Contains(string(data), "3 minutes ago") {
		t.Fatalf("TimeRel must not leak into JSON (agent payload compatibility): %s", data)
	}
}

func TestClampLimit(t *testing.T) {
	cases := map[int]int{0: DefaultLogN, -5: DefaultLogN, 7: 7, 99999: MaxLogN}
	for in, want := range cases {
		if got := ClampLimit(in); got != want {
			t.Fatalf("ClampLimit(%d) = %d, want %d", in, got, want)
		}
	}
}

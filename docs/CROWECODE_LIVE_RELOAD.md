# Crowe Code Live Reload — protocol & reconcile kernel

A small, editor-agnostic contract for keeping an open editor buffer in sync with
a file that an **autonomous agent** or an **external editor** may also be
writing. The goal is to make "watch the AI code" safe, perceivable, and
portable — and eventually a shared standard across coding apps rather than a
per-app reinvention.

## Why this exists

Every AI coding tool re-solves the same problem when an agent edits files on
disk: *reload the editor, but don't clobber the human's unsaved work, and show
them what changed and who changed it.* Most solve it ad hoc. This documents the
minimal kernel so it can be reused and standardized.

## The event (wire contract)

Emitted whenever a file an editor has open is mutated on disk:

```jsonc
{
  "path":   "/abs/path/to/file",   // absolute, symlink-resolved
  "op":     "write" | "edit" | "external",
  "origin": "agent" | "external" | "self"   // provenance — who changed it
}
```

`origin` is the load-bearing primitive. "Who touched my code, and where?" is the
trust question that gates AI-coding adoption; everything else is mechanics.

- `agent` — an in-app agent tool wrote the file (Crowe Code: `editor.write_file`
  / `editor.apply_edit`).
- `external` — an out-of-app editor or process wrote it (observed via fsnotify).
- `self` — the editor's own save. Carried for completeness; in practice a
  self-save produces an empty diff and reconciles silently.

In this repo the event is the WPS event `crowecode:filechange`
(`pkg/wps/wpstypes.go`), scoped by absolute path. Publishers:
`pkg/agent/tools/editor` (origin `agent`) and `pkg/crowecode/livewatch`
(origin `external`, fsnotify directory watch, ref-counted, self-healing).

## The reconcile policy

Pure decision, no editor dependency — see
`frontend/app/view/crowecode/reconcile.ts` (`decideReconcile`):

| open file matches? | buffer dirty? | action   |
| ------------------ | ------------- | -------- |
| no                 | —             | `ignore` |
| yes                | yes           | `guard`  |
| yes                | no            | `reload` |

- **reload** — re-read from disk; the buffer was clean, so there is nothing to
  lose. Disk is the single source of truth (no buffer-vs-disk merge).
- **guard** — the buffer has unsaved edits; do **not** reload. Surface a
  conflict ("changed on disk") with explicit save-overwrites / discard-and-reload
  affordances. Never silently clobber.
- **ignore** — the change is for a file this editor doesn't have open.

## Perceivability (accessibility requirements)

A reload must be perceivable without relying on any single channel:

- **Not color-alone** — a gutter glyph marks each changed line (Monaco
  `linesDecorationsClassName`), independent of the gold flash.
- **Respect `prefers-reduced-motion`** — static highlight instead of the fade
  animation.
- **Screen readers** — an `aria-live="polite"` region announces what reloaded,
  where, and by whom (`describeReload`), e.g. *"service.go reloaded — lines 10 to
  12 changed by the agent."*

## What is reusable

`reconcile.ts` is framework-free (no Monaco, Jotai, or Wave) and unit-tested
(`reconcile.test.ts`): `decideReconcile`, `changedLineRange`, `describeReload`.
That module plus the event contract above is the extractable core — the intended
shape of a future `@crowe/live-reconcile` package and the basis for proposing an
MCP "edit-and-notify" capability so any agent can drive the same reconcile.

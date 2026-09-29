# Crowe Browser Runtime: Jev integration plan

## Decision

Build a Crowe-owned browser execution subsystem for Hypheus and Cortex. It will adopt Jev Ultrafast's observable-state, typed-action, freshness-checked execution model, but it will not vendor, fork, or copy Jev code into `crowe-terminal` during this planning phase.

The first implementation target is a supervised web-block operation loop, not autonomous marketplace, billing, release, credential, or messaging actions.

## Evidence and provenance status

- Evaluated upstream: `https://github.com/browser-use/jev-ultrafast`
- Evaluated revision: `1231850a0bf1a0c0341fe408ef1668dbbfdfac46` (`main`, retrieved 2026-09-24)
- Upstream license: MIT, Copyright (c) 2026 Browser Use
- Current repository status: no Jev source, dependency, fork, or derived file is present in `crowe-terminal`.
- Consequently, `LICENSES/jev-ultrafast-MIT.txt`, `UPSTREAM.md`, and a Jev entry in an SBOM must not be added yet. They become release requirements before any upstream code or a substantial upstream-derived adaptation is committed.

If code is imported, add the following before the same change is released:

1. `LICENSES/jev-ultrafast-MIT.txt`, containing the unmodified upstream MIT notice.
2. `UPSTREAM.md`, naming the upstream URL, pinned revision, imported source paths, Crowe destination paths, modification summary, and update procedure.
3. A release SBOM entry that identifies the upstream component and license.
4. File-level SPDX and provenance comments on copied or substantially derived files.

No rights to the Jev or Browser Use names, marks, endorsements, or compatibility claims are assumed.

## Existing Crowe integration surface

The local app already has a supervised embedded-browser bridge:

- `frontend/app/view/webview/webview-wsh.tsx` executes a backend-routed script only inside a specified in-window web block and returns the webview URL and title.
- `frontend/app/view/webview/webview-wsh.tsx` can capture the web block as PNG.
- `pkg/agent` provides the tool registry used by the Crowe agent.

This makes the first runtime boundary clear: browser observation and action must be added as typed operations over a selected web block. The planner must never receive arbitrary JavaScript execution authority.

## Architecture

```text
CroweLM / Cortex planner
          |
          v
Typed decision: operation + live target id
          |
          v
Policy gate and required human approval
          |
          v
Crowe Browser Runtime
  observe -> validate freshness -> execute -> observe
          |
          v
Existing embedded web block
          |
          v
Independent verifier and durable operation trace
```

### Core contracts

1. **Observation** creates a page snapshot with canonical URL, title, timestamp, page fingerprint, and indexed actionable elements.
2. **Decision** is limited to an operation from an allowlist and a target from that exact snapshot. It cannot contain selectors, page JavaScript, screen coordinates, or untyped commands.
3. **Execution** rejects a stale fingerprint, a missing target, or an operation-target mismatch.
4. **Policy** classifies every operation before execution. Reading and drafting can be automatically allowed within an attached web block. Any external side effect must be denied or await explicit approval.
5. **Verification** separately evaluates the original goal against the final snapshot and required evidence. It returns `PASS`, `FAIL`, `INCOMPLETE`, or `NEEDS_HUMAN_REVIEW`.
6. **Trace** records each observation fingerprint, proposed action, policy decision, approval reference, result, and verification outcome.

## Initial typed operations

The first vertical slice supports only these operations:

- `OBSERVE`
- `CLICK`
- `TYPE_TEXT`
- `SELECT_OPTION`
- `PRESS_KEY`
- `SCROLL`
- `DONE`
- `BLOCKED`

`TYPE_TEXT` must carry an explicit classification of public, private-business, or credential data. Credential fields are always user-controlled and cannot be filled by the runtime.

The following remain out of the first slice: file upload or download, pop-ups, multi-tab control, authentication, payment, publication, email or messaging sends, marketplace updates, account recovery, and arbitrary script execution.

## Policy matrix for the first slice

| Operation and target | Default decision |
| --- | --- |
| Observe an attached web block | Allow |
| Click, type, select, or scroll with no external side effect | Allow |
| Navigate away from the user-selected origin | Require approval |
| Submit a form, send a message, publish, purchase, refund, delete, or change a business record | Require approval |
| Credential, payment, recovery, or identity field | Deny to runtime, user-controlled only |
| Unknown side effect or target classification | Block |

## Delivery sequence

### Phase 1: observable web-block actions

Add typed observation and a small typed-action RPC surface to the existing web-block bridge. Return element IDs and a fingerprint, accept only a supported operation plus an element ID, and reject stale snapshots. Add unit tests for stale observations, invalid target IDs, and invalid operation-target pairs.

### Phase 2: policy, approval, and trace

Add a server-side policy evaluator, approval request model, and append-only operation trace. Test that all consequential actions stop before webview mutation without an approval record.

### Phase 3: independent verification and replay fixtures

Add deterministic verifier rules for URLs, visible text, form confirmation states, and record identifiers. Record fixtures from consented internal workflows and make them regression tests.

### Phase 4: operational proof

Run read-only daily reconciliation for the mushroom operation: collect order, harvest, inventory, and fulfillment facts; produce an evidence-backed exception report; do not make external changes. Measure completion rate, manual minutes saved, and exceptions correctly identified before expanding action authority.

## Acceptance criteria for Phase 1

- A browser snapshot contains a canonical URL, title, fingerprint, and stable indexed visible controls.
- The agent can request only the six supported operations plus `DONE` and `BLOCKED`.
- An action cannot execute after a page mutation changes the fingerprint.
- An action cannot target an element that was not in the exact snapshot.
- The runtime records both success and failure with the original snapshot fingerprint.
- The existing arbitrary `webexecutejs` bridge is not exposed as an action available to the browser runtime planner.
- Unit tests cover the allowed action matrix and stale-action rejection.

## Commercial boundary

The open or inspectable layer can be the typed action protocol and local observation tooling. The proprietary value layer is policy packs, approval routing, organization workflow memory, evidence traces, verification services, evaluation fixtures, managed integrations, and CroweLM grounding. Basic safety controls are not paywalled.

# MCP-UI Interactive Demo Runbook

This runbook covers the env-gated demo used to run the Task 8 manual smoke test
for interactive MCP-UI blocks. It lets a maintainer launch Crowe Code, surface a
live widget in a sandboxed iframe, and confirm that iframe actions round-trip
back through the agent.

## What the demo does

When enabled, the package `pkg/agent/tools/mcpuidemo` registers two non-mutating
tools in the agent registry:

- `mcpui.demo.show` renders a self-contained interactive widget into an `mcpui`
  block. The widget posts MCP-UI protocol messages (`tool`, `link`, `notify`)
  to the host and logs every message it receives back.
- `mcpui.demo.echo` echoes the params it was called with, so you can SEE that
  iframe `tool` params arrived as a real object (not a quoted string) after the
  postMessage encoding round-trip.

The demo is inert unless the env var is set, exactly like the `fsmcp` mount.

## How to enable

Set the env var in the same shell you launch Crowe Code from, before starting it:

```bash
export CROWE_AGENT_MCPUI_DEMO=1
```

Then launch the dev build from the project root:

```bash
task electron:quickdev
```

If you hit single-instance-lock or address-in-use errors, use the one-shot
fresh launch instead:

```bash
task dev:fresh
```

Without `CROWE_AGENT_MCPUI_DEMO=1` the two tools are never registered and the
demo has no effect.

## How to invoke

Open the in-app agent (waveai block) and ask it to call the `mcpui.demo.show`
tool, for example: "call the mcpui.demo.show tool". The agent invokes the tool
through the registry, which renders the widget into a new `mcpui` block split
off the calling block.

## Task 8 checklist

Walk these in order. Each step maps to a part of the demo.

1. `mcpui.demo.show` -> a new `mcpui` block appears rendering the widget in a
   sandboxed iframe. Inspect the element: it has `sandbox="allow-scripts"` and
   does NOT include `allow-same-origin`.
2. Click "Run echo tool" in the widget. If scope gating is active you get a
   Wave approval prompt. Approve it; the `mcpui.demo.echo` tool runs and its
   echoed params show up in the agent transcript, proving the params arrived as
   a real object (the echoed JSON shows `{"msg":"hello from the iframe","n":42}`,
   not a quoted string). Use the "Send custom" input to repeat with dynamic
   content.
3. Click "Open link" -> the browser opens modelcontextprotocol.io.
4. Re-run `mcpui.demo.show` -> the SAME block updates in place (no second block
   is created), because the renderer is keyed by (session, tool).
5. The widget log area shows a `ui-message-received` ack for every message that
   carried a `messageId` (the echo actions use `messageId` echo-1 and
   echo-custom). Seeing the ack in the log confirms the host received and
   acknowledged the action.

## Notes

- The "Notify" button posts a `notify` action; how that surfaces depends on the
  host notify handler.
- The demo registers tools at process start via `init()`, so toggling the env
  var requires relaunching Crowe Code.

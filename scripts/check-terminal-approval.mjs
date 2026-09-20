// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const Require = createRequire(import.meta.url);
const { chromium } = Require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const Base = new URL(process.env.PREVIEW_URL || "http://127.0.0.1:7011");
assert(["127.0.0.1", "localhost", "[::1]"].includes(Base.hostname), "Only loopback preview URLs are allowed");
assert.equal(Base.protocol, "http:");
const Output = process.env.SCREENSHOT_DIR || (await mkdtemp(path.join(os.tmpdir(), "hypheus-terminal-approval-")));
const Browser = await chromium.launch({
  channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  headless: true,
});
const Results = [];
const Cases = [
  "approve",
  "deny",
  "retry",
  "abort",
  "missing",
  "invalid",
  "consecutive",
  "reorder",
  "history",
  "long",
  "ack-end",
  "ack-stop",
  "ack-error",
  "timeout",
  "bidi",
  "batch-focus",
];
await mkdir(Output, { recursive: true });

async function snapshot(page) {
  return page.evaluate(() => window.terminalApprovalFixture.snapshot());
}

async function waitForState(page, predicate, argument) {
  await page.waitForFunction(
    ({ source, argument }) => {
      const state = window.terminalApprovalFixture?.snapshot();
      return state && new Function("state", "argument", `return (${source})(state, argument)`)(state, argument);
    },
    { source: predicate.toString(), argument }
  );
  return snapshot(page);
}

async function settle(page, id, outcome = "success", publish = true) {
  await page.evaluate(({ id, outcome }) => window.terminalApprovalFixture.releaseRpc(id, outcome), { id, outcome });
  if (outcome === "success" && publish) {
    await page.evaluate((id) => window.terminalApprovalFixture.publish(id), id);
  }
}

function card(page, id) {
  return page.locator(`[data-toolcallid="${id}"]`);
}

async function checkPreview(page, part) {
  const element = card(page, part.data.toolcallid);
  const proposal = part.data.terminalproposal;
  await element.waitFor();
  assert.equal(
    await element.getByTestId("terminal-command").textContent(),
    proposal.command,
    "Command preview must preserve every character"
  );
  assert.equal(
    await element.getByTestId("terminal-target").textContent(),
    proposal.blockid,
    "Full canonical block UUID must be visible"
  );
  assert((await element.textContent()).includes(proposal.tabid), "Full canonical tab UUID must be visible");
  const selection = await element.getByTestId("terminal-command").evaluate((pre) => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return {
      text,
      children: pre.querySelectorAll("a, b, img, script").length,
      userselect: getComputedStyle(pre).userSelect,
    };
  });
  assert.equal(selection.text, proposal.command, "Selection must preserve the exact command");
  assert.equal(selection.children, 0, "Command is text, never interpreted markup");
  assert.notEqual(selection.userselect, "none");
}

async function geometry(page) {
  const metrics = await page.locator('[data-testid="terminal-approval"]').evaluate((pane) => {
    const transcript = pane.querySelector(".crowe-scroll-thin");
    const panel = pane.querySelector('[data-aipanel="true"]');
    const input = pane.querySelector("textarea");
    const rect = panel.getBoundingClientRect();
    const violations = [];
    for (const [name, element] of [
      ["pane", pane],
      ["panel", panel],
      ["transcript", transcript],
    ]) {
      if (element.scrollWidth > element.clientWidth + 1) violations.push(`${name} overflows horizontally`);
    }
    for (const element of pane.querySelectorAll("[data-toolcallid], textarea, form")) {
      const box = element.getBoundingClientRect();
      if (box.left < rect.left - 1 || box.right > rect.right + 1)
        violations.push("Card or composer crosses panel boundary");
    }
    const inputBox = input.getBoundingClientRect();
    if (inputBox.bottom > rect.bottom + 1 || inputBox.top < rect.top) violations.push("Composer clipped vertically");
    return {
      width: pane.clientWidth,
      transcriptwidth: transcript.clientWidth,
      scrollwidth: transcript.scrollWidth,
      scrollheight: transcript.scrollHeight,
      viewportheight: transcript.clientHeight,
      violations,
    };
  });
  assert.deepEqual(metrics.violations, []);
  return metrics;
}

try {
  for (const width of [320, 450, 720]) {
    for (const scenario of Cases) {
      const context = await Browser.newContext({ viewport: { width: 1150, height: 950 }, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors = [];
      const blocked = [];
      const consoleerrors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleerrors.push(message.text());
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== Base.origin || request.method() !== "GET" || /\/api\/|\/wave\/service/.test(url.pathname)) {
          blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      await page.routeWebSocket("**/*", (socket) => socket.close());
      const result = { width, scenario, checks: [], screenshots: [], errors, blocked, consoleerrors };
      const screenshot = async (name) => {
        const filename = path.join(Output, `${width}-${scenario}-${name}.png`);
        await page.screenshot({ path: filename, animations: "disabled" });
        result.screenshots.push(filename);
      };
      try {
        await page.goto(`${Base.origin}/?preview=terminal-approval&width=${width}&case=${scenario}`);
        await page.locator('[data-aipanel="true"] textarea').waitFor();
        await waitForState(page, (state) => state.historyloads >= 1);
        await page.evaluate(() => document.fonts.ready);
        const input = page.locator('[data-aipanel="true"] textarea');
        if (scenario === "history") {
          await page.locator("[data-toolcallid]").first().waitFor();
          const state = await snapshot(page);
          for (const part of state.slots) await checkPreview(page, part);
          assert.equal(await page.getByRole("button", { name: "Approve typing", exact: true }).count(), 0);
          assert.equal(state.decisions.length, 0);
          result.checks.push("History preserves previews without reviving stale approvals");
        } else {
          if (scenario === "approve") {
            await input.fill("Fixture first line");
            await input.press("Shift+Enter");
            await input.pressSequentially("Fixture second line");
            assert.equal(await input.inputValue(), "Fixture first line\nFixture second line");
            assert.equal((await snapshot(page)).requests.length, 0, "Shift+Enter cannot send");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            result.checks.push("Shift+Enter newline and Send button traverse real composer/transport");
          } else {
            await input.fill(`Inert ${scenario} scenario`);
            await input.press("Enter");
            result.checks.push("Enter submits through real composer/transport");
          }
          let state = await waitForState(page, (value) => value.requests.length === 1 && value.active);
          await page.locator("[data-toolcallid]").first().waitFor();
          assert.equal(await input.inputValue(), "");
          assert.equal(state.writes.length, 0, "No typing before approval");
          assert.equal(state.decisions.length, 0);
          assert.equal(
            state.requests[0].msg.parts[0].text,
            scenario === "approve" ? "Fixture first line\nFixture second line" : `Inert ${scenario} scenario`
          );
          const first = state.slots[0];
          const firstCard = card(page, first.data.toolcallid);
          if (!["missing", "invalid", "bidi", "batch-focus"].includes(scenario)) await checkPreview(page, first);
          result.geometry = await geometry(page);
          await screenshot("pending");

          if (["missing", "invalid", "bidi"].includes(scenario)) {
            const approve = firstCard.getByRole("button", { name: "Approve typing", exact: true });
            assert(
              (await approve.count()) === 0 || (await approve.isDisabled()),
              "Invalid preview must block approval"
            );
            await firstCard.getByRole("button", { name: "Deny", exact: true }).click();
            await waitForState(page, (value) => value.pending.length === 1);
            await settle(page, first.data.toolcallid);
            result.checks.push("Missing/invalid proposal blocks approval, permits denial, types nothing");
          } else if (scenario === "batch-focus") {
            // The composer deliberately refocuses 100ms after submission; isolate the subsequent batch updates.
            await page.waitForTimeout(250);
            const focused = await card(page, "file-b")
              .getByRole("button", { name: "Deny", exact: true })
              .elementHandle();
            await focused.evaluate((button) => button.focus());
            const phaseOrders = {
              move: ["file-b"],
              add: ["file-b", "file-c"],
              remove: ["file-b"],
              restore: ["file-b", "file-c", "file-a"],
              reorder: ["file-b", "file-a", "file-c"],
            };
            for (const [phase, order] of Object.entries(phaseOrders)) {
              await page.evaluate((phase) => window.terminalApprovalFixture.updateBatch(phase), phase);
              await page.waitForFunction((order) => {
                const actionable = [...document.querySelectorAll("[data-toolcallid]")]
                  .filter((element) =>
                    [...element.querySelectorAll("button")].some((button) => button.textContent === "Deny")
                  )
                  .map((element) => element.getAttribute("data-toolcallid"));
                return JSON.stringify(actionable) === JSON.stringify(order);
              }, order);
              const focusState = await focused.evaluate((button) => ({
                connected: button.isConnected,
                same: document.querySelector('[data-toolcallid="file-b"] button:last-child') === button,
                focused: document.activeElement === button,
                active: document.activeElement?.tagName,
              }));
              result.focusstates ??= [];
              result.focusstates.push({ phase, ...focusState });
              assert(focusState.connected && focusState.same, `File b DOM node must survive ${phase}`);
              assert(focusState.focused, `File b focus must survive ${phase}; active=${focusState.active}`);
              assert.equal((await snapshot(page)).decisions.length, 0, "Batch updates must not trigger an action");
            }
            await screenshot("batch-focus-preserved");
            await page.getByRole("button", { name: "Stop response", exact: true }).click();
            await waitForState(page, (value) => value.aborts === 1);
            result.checks.push(
              "Unchanged file b keeps identical focused DOM button while c changes batch/add/remove/reorder; no unintended actions"
            );
          } else if (scenario === "abort") {
            await page.getByRole("button", { name: "Stop response", exact: true }).click();
            await waitForState(page, (value) => value.aborts === 1 && value.historyloads >= 2);
            assert.equal(await page.getByRole("button", { name: "Approve typing", exact: true }).count(), 0);
            result.checks.push("Stop aborts HTTP stream and reloads canceled history without approval");
          } else if (scenario === "deny") {
            await firstCard.getByRole("button", { name: "Deny", exact: true }).click();
            await waitForState(page, (value) => value.pending.length === 1);
            await settle(page, first.data.toolcallid);
            result.checks.push("Deny RPC and server snapshot produce no fake typing");
          } else {
            const approve = firstCard.getByRole("button", { name: "Approve typing", exact: true });
            await approve.evaluate((button) => {
              button.click();
              button.click();
            });
            await waitForState(page, (value) => value.pending.length === 1);
            assert.equal((await snapshot(page)).decisions.length, 1, "Repeat clicks must not duplicate RPC");
            assert(await approve.isDisabled(), "Approve disabled while RPC pending");
            assert(await firstCard.getByRole("button", { name: "Deny", exact: true }).isDisabled());
            result.checks.push("Per-call awaited pending state blocks duplicate and conflicting clicks");
            if (scenario === "timeout") {
              const started = Date.now();
              assert.equal((await snapshot(page)).wire[0].timeout, 10000);
              await firstCard.getByRole("alert").waitFor({ timeout: 15000 });
              assert((await firstCard.getByRole("alert").textContent()).includes("EC-TIME"));
              assert(
                Date.now() - started >= 8500,
                "Real RPC deadline must elapse rather than a synthetic immediate rejection"
              );
              await page.waitForTimeout(500);
              state = await snapshot(page);
              assert.equal(state.decisions.length, 1, "Timeout cannot automatically retry");
              assert.equal(state.writes.length, 0);
              assert.equal(state.openrpcs, 0, "Timed out real RPC must clean up");
              await screenshot("rpc-timeout");
              await firstCard.getByRole("button", { name: "Approve typing", exact: true }).click();
              await waitForState(page, (value) => value.pending.length === 1 && value.decisions.length === 2);
              result.checks.push(
                "Real WshClient 10000ms timeout cleans up, reports ambiguity, never auto-retries, accepts deliberate retry"
              );
            }
            if (scenario === "retry" || scenario === "reorder") {
              if (scenario === "reorder") {
                await page.evaluate(() => window.terminalApprovalFixture.reorder());
                await page.waitForFunction(
                  () =>
                    document.querySelector("[data-toolcallid]")?.getAttribute("data-toolcallid") ===
                    window.terminalApprovalFixture.snapshot().slots[0].data.toolcallid
                );
                assert(
                  await card(page, first.data.toolcallid)
                    .getByRole("button", { name: "Approve typing", exact: true })
                    .isDisabled()
                );
              }
              await settle(page, first.data.toolcallid, "error");
              await firstCard.getByRole("alert").waitFor();
              assert((await firstCard.getByRole("alert").textContent()).includes("Fixture approval RPC unavailable"));
              assert.equal((await snapshot(page)).writes.length, 0);
              await screenshot("rpc-error");
              await firstCard.getByRole("button", { name: "Approve typing", exact: true }).click();
              await waitForState(page, (value) => value.pending.length === 1 && value.decisions.length === 2);
              result.checks.push("RPC failure remains visible on original call and retries safely");
            }
            await settle(page, first.data.toolcallid, "success", false);
            await firstCard
              .getByRole("status")
              .filter({ hasText: "Decision received. Waiting for tool status." })
              .waitFor();
            assert.equal((await snapshot(page)).writes.length, 1);
            assert.equal(await firstCard.getByRole("button", { name: "Approve typing", exact: true }).count(), 0);
            assert.equal(await firstCard.getByRole("button", { name: "Deny", exact: true }).count(), 0);
            assert.equal(
              (await snapshot(page)).slots.find((part) => part.data.toolcallid === first.data.toolcallid).data.status,
              "pending"
            );
            assert(
              !(await firstCard.textContent()).includes("Text typed; Enter was not sent."),
              "RPC success alone cannot replace authoritative server state"
            );
            await screenshot("rpc-acknowledged");
            if (scenario.startsWith("ack-")) {
              if (scenario === "ack-stop") {
                await page.getByRole("button", { name: "Stop response", exact: true }).click();
                await waitForState(page, (value) => value.aborts === 1 && value.historyloads >= 2);
              } else {
                await page.evaluate(
                  (error) => window.terminalApprovalFixture.endWithoutStatus(error),
                  scenario === "ack-error"
                );
              }
              await firstCard
                .getByText("Decision received. Tool outcome unconfirmed; the response ended before confirmation.", {
                  exact: true,
                })
                .waitFor();
              const text = await firstCard.textContent();
              assert(!text.includes("Not approved") && !text.includes("Text typed; Enter was not sent."));
              assert.equal(await firstCard.getByRole("button").count(), 0);
              result.checks.push(
                "Acknowledged decision followed by stream end/stop/error remains outcome unconfirmed, never false denial/completion or actionable"
              );
            } else {
              await page.evaluate((id) => window.terminalApprovalFixture.publish(id), first.data.toolcallid);
            }
            if (["consecutive", "reorder"].includes(scenario)) {
              state = await snapshot(page);
              const second = state.slots.find((part) => part.data.toolcallid !== first.data.toolcallid);
              await checkPreview(page, second);
              assert(
                await card(page, second.data.toolcallid)
                  .getByRole("button", { name: "Approve typing", exact: true })
                  .isEnabled()
              );
              assert.equal(
                await card(page, second.data.toolcallid).getByRole("alert").count(),
                0,
                "Failure state cannot move to another call"
              );
              await card(page, second.data.toolcallid).getByRole("button", { name: "Deny", exact: true }).click();
              await waitForState(page, (value) => value.pending.length === 1);
              await settle(page, second.data.toolcallid);
              result.checks.push("Consecutive/reordered call remains independently actionable and denial is isolated");
            }
            if (!scenario.startsWith("ack-"))
              result.checks.push(
                "One exact fake typed string, no appended newline or execution; server snapshot completes card"
              );
          }
          await page.waitForFunction(
            (status) => window.aichatstatus === status,
            scenario === "ack-error" ? "error" : "ready"
          );
          state = await snapshot(page);
          assert.equal(
            state.writes.length,
            [
              "approve",
              "retry",
              "consecutive",
              "reorder",
              "long",
              "timeout",
              "ack-end",
              "ack-stop",
              "ack-error",
            ].includes(scenario)
              ? 1
              : 0
          );
          for (const write of state.writes) {
            const matching = state.slots.find((part) => part.data.toolcallid === write.toolcallid);
            assert.deepEqual(write, { toolcallid: matching.data.toolcallid, ...matching.data.terminalproposal });
          }
          assert.equal(await page.getByRole("button", { name: "Approve typing", exact: true }).count(), 0);
          if (scenario === "long") {
            const transcript = page.locator('[data-testid="terminal-approval"] .crowe-scroll-thin').first();
            const scroll = await transcript.evaluate((element) => {
              element.scrollTop = 0;
              const top = element.scrollTop;
              element.scrollTop = element.scrollHeight;
              return { top, bottom: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight };
            });
            assert(scroll.bottom > 0 && scroll.height > scroll.viewport);
            await screenshot("scrolled-bottom");
            await transcript.evaluate((element) => {
              element.scrollTop = 0;
            });
            await screenshot("scrolled-top");
            await page.getByRole("slider", { name: "Fixture pane width" }).fill(String(width === 320 ? 720 : 320));
            await page.waitForTimeout(200);
            result.resized = await geometry(page);
            await screenshot("resized");
            result.checks.push("Long transcript scrolls and composer stays within live resized pane");
          }
        }
        result.geometry = await geometry(page);
        result.state = await snapshot(page);
        assert.equal(result.state.fakeexecutioncount, 0);
        assert(result.state.telemetryblocked > 0, "Telemetry EventSource must be disabled");
        assert.deepEqual(result.state.violations, []);
        assert.deepEqual(blocked, [], "No live or unexpected API requests");
        assert.deepEqual(errors, []);
        assert.deepEqual(
          consoleerrors.filter(
            (error) =>
              !error.startsWith("[vite] failed to connect to websocket.") &&
              !(
                scenario === "ack-error" &&
                error.startsWith("AI Chat error: Error: Fixture stream interrupted after decision acknowledgment")
              )
          ),
          [],
          "Unexpected browser console errors"
        );
        await screenshot("final");
        result.passed = true;
      } catch (error) {
        result.passed = false;
        result.failure = error.stack || String(error);
        result.state = await snapshot(page).catch(() => null);
        await screenshot("failure").catch(() => {});
      } finally {
        Results.push(result);
        await context.close();
        await writeFile(path.join(Output, "results.json"), JSON.stringify(Results, null, 2));
        console.log(
          JSON.stringify({ width, scenario, passed: result.passed, failure: result.failure, checks: result.checks })
        );
      }
    }
  }
} finally {
  await Browser.close();
}
console.log(
  JSON.stringify({ output: Output, passed: Results.filter((result) => result.passed).length, total: Results.length })
);
if (Results.some((result) => !result.passed)) process.exitCode = 1;

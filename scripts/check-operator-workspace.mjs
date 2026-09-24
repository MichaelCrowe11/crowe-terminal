// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const base = new URL(process.env.PREVIEW_URL || "http://127.0.0.1:7007");
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Only a local preview server is allowed");
const output = path.resolve(process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), `hypheus-operator-${Date.now()}`));
const root = path.resolve(import.meta.dirname, "..");
assert(!output.startsWith(root + path.sep) && output !== root, "Keep browser artifacts outside the repository");
const fixtures = (process.env.PREVIEW_CASES || "signedout,pending,connected,storage,legacykey").split(",");
const widths = (process.env.PREVIEW_WIDTHS || "280,320,460").split(",").map(Number);
const themes = (process.env.PREVIEW_THEMES || "dark,light").split(",");
const browser = await chromium.launch({
  channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  headless: true,
});
const results = [];
await mkdir(output, { recursive: true });

async function inspectLayout(page, label, violations) {
  const metrics = await page.locator('[data-testid="operator-workspace"]').evaluate((workspace) => {
    const issues = [];
    const pane = workspace.querySelector("#crowe-operator-pane");
    const controls = [...workspace.querySelectorAll("button, textarea, [role=separator]")].filter(
      (el) => el.getClientRects().length
    );
    for (const el of controls) {
      const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent?.trim();
      if (!name) issues.push(`Unnamed ${el.tagName.toLowerCase()}`);
    }
    const targets = [
      workspace,
      ...workspace.querySelectorAll(
        "#crowe-operator-pane, .crowe-operator-header, .crowe-operator-authority, .crowe-account-setup, .crowe-model-list"
      ),
    ];
    for (const target of targets) {
      if (target.clientWidth && target.scrollWidth > target.clientWidth + 1) {
        issues.push(`Horizontal overflow: ${target.className}`);
      }
    }
    const textarea = workspace.querySelector("textarea");
    const bounds = workspace.getBoundingClientRect();
    if (textarea) {
      const rect = textarea.getBoundingClientRect();
      if (rect.bottom > bounds.bottom + 1 || rect.right > bounds.right + 1) issues.push("Composer outside workspace");
    }
    return { width: pane?.getBoundingClientRect().width ?? null, issues };
  });
  violations.push(...metrics.issues.map((issue) => `${label}: ${issue}`));
  await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
  return metrics;
}

try {
  for (const theme of themes) {
    for (const width of widths) {
      for (const fixture of fixtures) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
        const page = await context.newPage();
        const errors = [];
        const violations = [];
        const blockedrequests = [];
        const id = `${theme}-${width}-${fixture}`;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("popup", (popup) => {
          violations.push("Unexpected browser popup");
          void popup.close();
        });
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== base.origin || /^\/(api|wave|auth|oauth|crowe)(\/|$)/.test(url.pathname)) {
            blockedrequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
            return route.abort();
          }
          return route.continue();
        });
        assert(
          typeof page.routeWebSocket === "function",
          "Playwright must support routeWebSocket for network isolation"
        );
        await page.routeWebSocket("**/*", (socket) => {
          const url = new URL(socket.url());
          if (url.host === base.host && url.pathname === "/" && url.searchParams.has("token")) {
            // Keep the Vite handshake local so parallel edits cannot reload a case mid-assertion.
            socket.send(JSON.stringify({ type: "connected" }));
            socket.onMessage(() => {});
          } else {
            blockedrequests.push(`WebSocket ${url.origin}${url.pathname}`);
            socket.close();
          }
        });
        try {
          await page.goto(`${base.origin}/?preview=utilitydock&account=${fixture}&width=${width}&theme=${theme}`);
          await page.getByRole("textbox", { name: "Message Hypheus" }).waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => window.operatorPreview?.calls.includes("croweauthstatus"));
          await page.waitForTimeout(150);
          const metrics = await inspectLayout(page, `${id}-initial`, violations);
          if (metrics.width != null && Math.abs(metrics.width - width) > 2)
            violations.push(`Expected ${width}px pane, got ${metrics.width}`);
          assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
          assert.equal(await page.getByRole("note").count(), 1);
          const stateLabels = {
            signedout: "Not connected",
            pending: "Waiting for approval",
            connected: "Connected",
            storage: "Connection unavailable",
            legacykey: "Not connected",
          };
          assert.equal(
            await page
              .getByRole("button", { name: `Crowe account: ${stateLabels[fixture]}. Open account setup`, exact: true })
              .count(),
            1
          );
          if (fixture === "legacykey")
            assert.equal(await page.getByRole("button", { name: "Use Crowe account", exact: true }).count(), 1);
          const input = page.getByRole("textbox", { name: "Message Hypheus" });
          const draft = `Preview draft ${id}`;
          await input.fill(draft);
          await page.getByRole("button", { name: /^Choose engine\. Current engine:/ }).focus();
          await page.keyboard.press("Enter");
          await page.locator(".crowe-model-list").waitFor();
          await inspectLayout(page, `${id}-engines`, violations);
          await page
            .locator(".crowe-model-item")
            .filter({ has: page.locator(".crowe-model-name", { hasText: /^CroweLM Local$/ }) })
            .click();
          assert.equal(await input.inputValue(), draft);
          assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isEnabled(), true);
          if (fixture === "connected") {
            await page.getByRole("button", { name: /^Crowe account:.*Open account setup$/ }).click();
            const localSetup = page.getByRole("region", { name: "Crowe account setup" });
            await localSetup.getByRole("button", { name: "Use Crowe account by default", exact: true }).click();
            await page.waitForFunction(() => window.operatorPreview.calls.includes("setconfig"));
            await localSetup
              .getByText("Crowe account is the default for new tabs. Existing engine selections stay unchanged.", {
                exact: true,
              })
              .waitFor();
            assert.equal(
              await page
                .getByRole("button", { name: "Choose engine. Current engine: CroweLM Local", exact: true })
                .count(),
              1,
              "Saving a future default changed this tab's engine"
            );
            assert.equal(await input.inputValue(), draft);
          }
          await page.getByRole("button", { name: /^Choose engine\. Current engine:/ }).click();
          await page
            .locator(".crowe-model-item")
            .filter({ has: page.locator(".crowe-model-name", { hasText: /^Crowe account$/ }) })
            .click();
          assert.equal(await input.inputValue(), draft);
          await page.getByRole("button", { name: /^Crowe account:.*Open account setup$/ }).click();
          const setup = page.getByRole("region", { name: "Crowe account setup" });
          await setup.waitFor();
          await inspectLayout(page, `${id}-account`, violations);
          if (fixture === "connected") {
            assert.equal(await input.inputValue(), draft);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page
              .getByText("Preview response only. No model, terminal, file, or account service was contacted.", {
                exact: true,
              })
              .waitFor();
            assert.equal(await page.evaluate(() => window.operatorPreview.submissions), 1);
            await inspectLayout(page, `${id}-reply`, violations);
            await setup.getByRole("button", { name: "Disconnect account", exact: true }).click();
            await page.getByRole("button", { name: /Crowe account: Not connected/ }).waitFor();
          } else if (fixture === "pending") {
            assert.equal(await page.getByLabel("One-time sign-in code").innerText(), "PREVIEW-ONLY");
            await setup.getByRole("button", { name: "Open sign-in page", exact: true }).click();
            assert.equal(await page.evaluate(() => window.operatorPreview.externalactions), 1);
            await setup.getByRole("button", { name: "Cancel", exact: true }).click();
            await page.getByRole("button", { name: /Crowe account: Not connected/ }).waitFor();
            assert.equal(await input.inputValue(), draft);
          } else if (fixture === "storage") {
            assert.match(await setup.innerText(), /secure credential storage/);
            await setup.getByRole("button", { name: "Retry connection", exact: true }).click();
            assert.equal(await input.inputValue(), draft);
          } else {
            await page.getByRole("button", { name: "Connect Crowe account", exact: true }).click();
            assert.equal(await input.inputValue(), draft);
            await setup.getByRole("button", { name: "Connect account", exact: true }).click();
            await page.getByLabel("One-time sign-in code").waitFor();
            assert.equal(await page.evaluate(() => window.operatorPreview.externalactions), 1);
            await setup.getByRole("button", { name: "Cancel", exact: true }).click();
          }
          if (fixture !== "connected") assert.equal(await page.evaluate(() => window.operatorPreview.submissions), 0);
          const diagnostics = await page.evaluate(() => window.operatorPreview);
          violations.push(...diagnostics.blocked.map((action) => `Unsupported preview action: ${action}`));
          await page.getByRole("button", { name: "Unmount preview", exact: true }).click();
          await page.waitForFunction(() => window.operatorPreview?.active === false);
          const count = await page.evaluate(() => window.operatorPreview.calls.length);
          await page.waitForTimeout(2700);
          assert.equal(
            await page.evaluate(() => window.operatorPreview.calls.length),
            count,
            "RPC continued after teardown"
          );
        } catch (error) {
          violations.push(error.message);
          await page.screenshot({ path: path.join(output, `${id}-failure.png`), fullPage: true }).catch(() => {});
        } finally {
          results.push({ id, violations, errors, blockedrequests });
          console.log(JSON.stringify(results.at(-1)));
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Artifacts: ${output}`);
}
if (results.some((result) => result.violations.length || result.errors.length || result.blockedrequests.length))
  process.exitCode = 1;

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const base = process.env.PREVIEW_URL || "http://127.0.0.1:7007";
const output = process.env.SCREENSHOT_DIR || "/tmp/hypheus-chat-overflow";
const browser = await chromium.launch({
  channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  headless: true,
});
const results = [];
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  for (const width of [320, 450, 720]) {
    for (const name of ["prose", "tokens", "code", "table", "approval"]) {
      const errors = [];
      const onError = (error) => errors.push(error.message);
      page.on("pageerror", onError);
      await page.goto(`${base}/?preview=chat-overflow&width=${width}&case=${name}`);
      await page.locator('[data-testid="chat-overflow"] .crowe-msg-enter').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      const metrics = await page.locator('[data-testid="chat-overflow"]').evaluate((pane) => {
        const viewport = pane.querySelector(".crowe-scroll-thin");
        const rect = viewport.getBoundingClientRect();
        const violations = [];
        if (viewport.scrollWidth > viewport.clientWidth + 1) violations.push("transcript overflows horizontally");
        for (const row of viewport.querySelectorAll(".crowe-msg-enter")) {
          const content = row.lastElementChild;
          if (content.getBoundingClientRect().right > rect.right + 1) violations.push("message crosses viewport");
          if (content.scrollWidth > content.clientWidth + 1) violations.push("message content overflows");
        }
        const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          let parent = node.parentElement;
          let locallyBounded = false;
          while (parent && parent !== viewport) {
            const style = getComputedStyle(parent);
            if (style.overflowX === "auto" || style.textOverflow === "ellipsis") locallyBounded = true;
            parent = parent.parentElement;
          }
          if (locallyBounded) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if ([...range.getClientRects()].some((box) => box.right > rect.right + 1)) {
            violations.push("text crosses viewport");
          }
        }
        const scrollers = [...viewport.querySelectorAll("pre, div")].filter(
          (el) => getComputedStyle(el).overflowX === "auto" && el.scrollWidth > el.clientWidth + 1
        );
        for (const el of scrollers) {
          el.scrollLeft = 30;
          if (el.scrollLeft === 0) violations.push("wide content cannot scroll locally");
          el.scrollLeft = 0;
        }
        if (viewport.scrollHeight > viewport.clientHeight) {
          const previousTop = viewport.scrollTop;
          viewport.scrollTop = 25;
          if (!viewport.scrollTop) violations.push("transcript cannot scroll vertically");
          viewport.scrollTop = previousTop;
        }
        return {
          clientwidth: viewport.clientWidth,
          scrollwidth: viewport.scrollWidth,
          localscrollers: scrollers.length,
          violations,
        };
      });
      if (["code", "table"].includes(name) && metrics.localscrollers === 0)
        metrics.violations.push("missing local wide-content scroller");
      if (name === "approval") {
        const approve = page
          .locator('[data-toolcallid="pending"]')
          .getByRole("button", { name: "Approve typing", exact: true });
        await approve.scrollIntoViewIfNeeded();
        if (!(await approve.isVisible())) metrics.violations.push("approval not visible");
        await page.screenshot({ path: path.join(output, `${width}-approval-pending.png`) });
        await approve.click();
        if (await approve.count()) metrics.violations.push("inert preview approval did not update UI");
      }
      await page.screenshot({ path: path.join(output, `${width}-${name}.png`) });
      page.off("pageerror", onError);
      results.push({ width, name, ...metrics, errors });
    }
  }
} finally {
  await browser.close();
}
await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
for (const result of results) console.log(JSON.stringify(result));
if (results.some((result) => result.violations.length || result.errors.length)) process.exitCode = 1;

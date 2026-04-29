// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "browser.in_window.wait_for",
		Description: "Wait until a CSS selector appears (or disappears) in the in-window web block, " +
			"polling at 200ms. Returns when the condition is met or timeout. Read-only — useful before click/type.",
		Schema:   json.RawMessage(SchemaWaitFor),
		Mutating: false,
		Handler:  handleWaitFor,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.scroll",
		Description: "Scroll the in-window page or a specific element by pixels, or to an anchor selector.",
		Schema:      json.RawMessage(SchemaScroll),
		Mutating:    true,
		Handler:     handleScroll,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.hover",
		Description: "Dispatch mouseenter+mouseover+mousemove on a CSS selector in the in-window page. Useful for hover-only menus.",
		Schema:      json.RawMessage(SchemaHover),
		Mutating:    true,
		Handler:     handleHover,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.get_attr",
		Description: "Read attributes/text/value from a selector in the in-window page. Read-only.",
		Schema:      json.RawMessage(SchemaGetAttr),
		Mutating:    false,
		Handler:     handleGetAttr,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.select_option",
		Description: "Set a <select> element's value (or pick by visible label) and fire change. CSS selector required.",
		Schema:      json.RawMessage(SchemaSelectOption),
		Mutating:    true,
		Handler:     handleSelectOption,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.list_links",
		Description: "Return all visible <a> tags in the in-window page as {text, href}. Read-only. Useful for navigating without scraping markup.",
		Schema:      json.RawMessage(SchemaListLinks),
		Mutating:    false,
		Handler:     handleListLinks,
	})
}

const SchemaWaitFor = `{
  "type": "object",
  "properties": {
    "blockid":   {"type":"string"},
    "selector":  {"type":"string","minLength":1},
    "absent":    {"type":"boolean","default":false,"description":"If true, wait for the selector to NOT exist."},
    "timeout_ms":{"type":"integer","minimum":100,"maximum":60000,"default":10000}
  },
  "required":["blockid","selector"],
  "additionalProperties": false
}`

const SchemaScroll = `{
  "type": "object",
  "properties": {
    "blockid":   {"type":"string"},
    "selector":  {"type":"string","description":"If set, scrollIntoView on this element. Otherwise scroll by dy pixels."},
    "dy":        {"type":"integer","description":"Pixels to scroll vertically (positive = down). Used when selector is empty."},
    "behavior":  {"type":"string","enum":["smooth","auto"],"default":"smooth"}
  },
  "required":["blockid"],
  "additionalProperties": false
}`

const SchemaHover = `{
  "type": "object",
  "properties": {
    "blockid":  {"type":"string"},
    "selector": {"type":"string","minLength":1}
  },
  "required":["blockid","selector"],
  "additionalProperties": false
}`

const SchemaGetAttr = `{
  "type": "object",
  "properties": {
    "blockid":  {"type":"string"},
    "selector": {"type":"string","minLength":1},
    "attr":     {"type":"string","description":"Attribute name. Special values: 'text' (innerText), 'html' (innerHTML), 'value'."}
  },
  "required":["blockid","selector","attr"],
  "additionalProperties": false
}`

const SchemaSelectOption = `{
  "type": "object",
  "properties": {
    "blockid":  {"type":"string"},
    "selector": {"type":"string","minLength":1,"description":"CSS selector for the <select>"},
    "value":    {"type":"string","description":"Option value to set. Mutually exclusive with label."},
    "label":    {"type":"string","description":"Option text to match (case-insensitive). Used when value is empty."}
  },
  "required":["blockid","selector"],
  "additionalProperties": false
}`

const SchemaListLinks = `{
  "type": "object",
  "properties": {
    "blockid": {"type":"string"},
    "limit":   {"type":"integer","minimum":1,"maximum":500,"default":100}
  },
  "required":["blockid"],
  "additionalProperties": false
}`

type waitForArgs struct {
	BlockID   string `json:"blockid"`
	Selector  string `json:"selector"`
	Absent    bool   `json:"absent"`
	TimeoutMs int    `json:"timeout_ms"`
}

type scrollArgs struct {
	BlockID  string `json:"blockid"`
	Selector string `json:"selector"`
	DY       int    `json:"dy"`
	Behavior string `json:"behavior"`
}

type hoverArgs struct {
	BlockID  string `json:"blockid"`
	Selector string `json:"selector"`
}

type getAttrArgs struct {
	BlockID  string `json:"blockid"`
	Selector string `json:"selector"`
	Attr     string `json:"attr"`
}

type selectOptionArgs struct {
	BlockID  string `json:"blockid"`
	Selector string `json:"selector"`
	Value    string `json:"value"`
	Label    string `json:"label"`
}

type listLinksArgs struct {
	BlockID string `json:"blockid"`
	Limit   int    `json:"limit"`
}

func handleWaitFor(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args waitForArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	timeout := args.TimeoutMs
	if timeout <= 0 {
		timeout = 10000
	}
	if timeout > maxTimeoutMs {
		timeout = maxTimeoutMs
	}
	absent := "false"
	if args.Absent {
		absent = "true"
	}
	script := fmt.Sprintf(`(async () => {
  const sel = %s, absent = %s, deadline = Date.now() + %d;
  while (Date.now() < deadline) {
    const el = document.querySelector(sel);
    if (absent ? !el : !!el) {
      return { matched: true, ms: Date.now() - (deadline - %d) };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { matched: false, timed_out: true };
})()`, jsString(args.Selector), absent, timeout, timeout)
	return runJS(ctx, args.BlockID, script, timeout+2000)
}

func handleScroll(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args scrollArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	behavior := args.Behavior
	if behavior == "" {
		behavior = "smooth"
	}
	var script string
	if args.Selector != "" {
		script = fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  el.scrollIntoView({ behavior: %s, block: "center" });
  return { ok:true, scrolled_to_selector: true };
})()`, jsString(args.Selector), jsString(behavior))
	} else {
		script = fmt.Sprintf(`(() => {
  window.scrollBy({ top: %d, behavior: %s });
  return { ok:true, dy: %d, y_now: window.scrollY };
})()`, args.DY, jsString(behavior), args.DY)
	}
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleHover(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args hoverArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	script := fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  for (const type of ["mouseenter","mouseover","mousemove"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, clientX:cx, clientY:cy }));
  }
  return { ok:true, tag: el.tagName };
})()`, jsString(args.Selector))
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleGetAttr(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args getAttrArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	script := fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  const a = %s;
  let v;
  if (a === "text") v = el.innerText;
  else if (a === "html") v = el.innerHTML;
  else if (a === "value") v = el.value;
  else v = el.getAttribute(a);
  return { ok:true, attr:a, value: v == null ? null : String(v).slice(0, 4000) };
})()`, jsString(args.Selector), jsString(args.Attr))
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleSelectOption(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args selectOptionArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.Value == "" && args.Label == "" {
		return errResult(fmt.Errorf("either value or label is required")), nil
	}
	script := fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  if (el.tagName !== "SELECT") return { ok:false, reason:"not a <select>: "+el.tagName };
  const wantVal = %s, wantLabel = %s;
  let chosen = null;
  for (const opt of el.options) {
    if (wantVal && opt.value === wantVal) { chosen = opt; break; }
    if (!wantVal && wantLabel && opt.text.toLowerCase() === wantLabel.toLowerCase()) { chosen = opt; break; }
  }
  if (!chosen) return { ok:false, reason:"option not found" };
  el.value = chosen.value;
  el.dispatchEvent(new Event("input", { bubbles:true }));
  el.dispatchEvent(new Event("change", { bubbles:true }));
  return { ok:true, value: chosen.value, label: chosen.text };
})()`, jsString(args.Selector), jsString(args.Value), jsString(args.Label))
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleListLinks(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args listLinksArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 100
	}
	script := fmt.Sprintf(`(() => {
  const out = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (out.length >= %d) break;
    const text = (a.innerText || "").trim().slice(0, 200);
    if (!text && !a.getAttribute("aria-label")) continue;
    out.push({ text: text || a.getAttribute("aria-label"), href: a.href });
  }
  return { count: out.length, links: out };
})()`, limit)
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

#!/usr/bin/env node
/**
 * build-map.mjs
 *
 * Deterministic generator for the /vault-map visualization (presentation layer).
 *
 * Reads vault.json (§0.6) and, if present, usage.json (§U), and writes ONE
 * self-contained `vault-map.html` to the resolved scope. The HTML is:
 *   - SELF-CONTAINED: inline CSS + inline JS, NO external/CDN resources, NO network
 *     calls, no remote fonts. Renders offline from file://.
 *   - Dependency-free vanilla JS, semantic HTML, explicit dimensions.
 *   - DETERMINISTIC: identical input → byte-identical output (stable ordering).
 *   - Secret-free: only vault.json / usage.json fields are embedded.
 *
 * Visualization:
 *   - Resources grouped by category; each tile's AREA ∝ context cost
 *     (HIGH largest → ZERO smallest); color = status; an idle-severity tint overlays
 *     when usage.json is present (§U.4).
 *   - A hooks lane ordered by lifecycle event (SessionStart, UserPromptSubmit,
 *     PreToolUse, PostToolUse, Stop, …).
 *   - Header counts per category + per cost class; an honest legend noting usage is a
 *     best-effort signal.
 *
 * Usage:
 *   node build-map.mjs --root /path/.claude        # writes <root>/vault-map.html
 *   node build-map.mjs --root /path/.claude --stdout   # print HTML, don't write
 *
 * It decides nothing semantic beyond layout; the command bootstraps and reports.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const a = { root: null, scope: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") a.root = argv[++i];
    else if (argv[i] === "--scope") a.scope = argv[++i];
    else if (argv[i] === "--stdout") a.stdout = true;
  }
  return a;
}
function resolveRoot({ scope, root }) {
  if (root) return root;
  const projectRoot = join(process.cwd(), ".claude");
  const globalRoot = join(homedir(), ".claude");
  if (scope === "global") return globalRoot;
  if (scope === "project") return projectRoot;
  return existsSync(projectRoot) ? projectRoot : globalRoot;
}
function safeJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// HTML escape — never inject raw values unescaped.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// deterministic orderings
const CATEGORY_ORDER = ["agent", "skill", "command", "hook", "mcp", "plugin", "rule", "project"];
const COST_ORDER = ["HIGH", "MED", "LOW", "ZERO"];
const HOOK_EVENT_ORDER = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "Notification", "Stop", "SubagentStop", "PreCompact",
];

// cost → tile area (px²) via side length
const COST_SIDE = { HIGH: 132, MED: 100, LOW: 72, ZERO: 52 };
// status → base color
const STATUS_COLOR = {
  active: "#2f6f4f",
  disabled: "#6b7280",
  inferred: "#8a6d3b",
};
// usage severity → tint border
const SEV_TINT = {
  "🔴": "#c0392b",
  "🟠": "#d35400",
  "🟡": "#cc9a06",
  "⚪": "#9aa0a6",
};

function stableSort(arr, keyFn) {
  return arr
    .map((v, i) => [v, i])
    .sort((a, b) => {
      const ka = keyFn(a[0]);
      const kb = keyFn(b[0]);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a[1] - b[1];
    })
    .map((x) => x[0]);
}

function build(vault, usage) {
  const resources = Array.isArray(vault?.resources) ? vault.resources : [];
  // usage lookup by name
  const usageByName = {};
  if (usage && Array.isArray(usage.resources)) {
    for (const r of usage.resources) usageByName[r.name] = r;
  }
  const hasUsage = usage != null;

  // group by category
  const byCat = {};
  for (const r of resources) {
    const c = r.category || "project";
    (byCat[c] = byCat[c] || []).push(r);
  }

  // counts
  const catCounts = {};
  for (const c of CATEGORY_ORDER) catCounts[c] = (byCat[c] || []).length;
  const costCounts = { HIGH: 0, MED: 0, LOW: 0, ZERO: 0 };
  for (const r of resources) {
    const cc = COST_ORDER.includes(r.contextCostClass) ? r.contextCostClass : "ZERO";
    costCounts[cc]++;
  }

  // ---- build category sections (skip empties) ----
  let sections = "";
  for (const cat of CATEGORY_ORDER) {
    const list = byCat[cat];
    if (!list || list.length === 0) continue; // omit empty categories cleanly
    if (cat === "hook") continue; // hooks render in their own lane below

    const sorted = stableSort(list, (r) => {
      const ci = COST_ORDER.indexOf(r.contextCostClass);
      return (ci === -1 ? 9 : ci).toString() + "|" + (r.name || "");
    });

    let tiles = "";
    for (const r of sorted) {
      const side = COST_SIDE[r.contextCostClass] ?? COST_SIDE.ZERO;
      const bg = STATUS_COLOR[r.status] ?? STATUS_COLOR.inferred;
      const u = usageByName[r.name];
      const sev = hasUsage && u ? u.severity : null;
      const tint = sev && SEV_TINT[sev] ? SEV_TINT[sev] : "transparent";
      const lastUsed = hasUsage && u && u.lastUsedISO ? u.lastUsedISO.slice(0, 10) : (hasUsage ? "never seen" : "");
      const title = [
        `${r.name}`,
        `category: ${r.category}`,
        `cost: ${r.contextCostClass}`,
        `status: ${r.status}`,
        `scope: ${r.scopeOf}`,
        hasUsage ? `last used: ${lastUsed}` : null,
      ].filter(Boolean).join(" • ");

      tiles +=
        `<div class="tile" style="width:${side}px;height:${side}px;background:${bg};` +
        `box-shadow:inset 0 0 0 4px ${tint};" title="${esc(title)}">` +
        `<span class="tname">${esc(r.name)}</span>` +
        `<span class="tmeta">${esc(r.contextCostClass)}</span>` +
        (hasUsage ? `<span class="tuse">${esc(lastUsed)}</span>` : "") +
        `</div>`;
    }

    sections +=
      `<section class="cat"><h2>${esc(cat)} <span class="n">(${list.length})</span></h2>` +
      `<div class="tiles">${tiles}</div></section>`;
  }

  // ---- hooks lane (ordered by lifecycle event) ----
  let hooksLane = "";
  const hooks = byCat["hook"] || [];
  if (hooks.length > 0) {
    // group hooks by event from triggerOrDescription (best-effort)
    const byEvent = {};
    for (const h of hooks) {
      const ev = HOOK_EVENT_ORDER.find((e) => (h.triggerOrDescription || "").includes(e)) || "other";
      (byEvent[ev] = byEvent[ev] || []).push(h);
    }
    const orderedEvents = [...HOOK_EVENT_ORDER, "other"].filter((e) => byEvent[e]);
    let lanes = "";
    for (const ev of orderedEvents) {
      const list = stableSort(byEvent[ev], (r) => r.name || "");
      let chips = "";
      for (const h of list) {
        const u = usageByName[h.name];
        const sev = hasUsage && u ? u.severity : null;
        const tint = sev && SEV_TINT[sev] ? SEV_TINT[sev] : "transparent";
        const bg = STATUS_COLOR[h.status] ?? STATUS_COLOR.inferred;
        chips += `<span class="chip" style="background:${bg};box-shadow:inset 0 0 0 3px ${tint};" title="${esc(h.name)}">${esc(h.name)}</span>`;
      }
      lanes += `<div class="lane"><div class="lane-label">${esc(ev)}</div><div class="chips">${chips}</div></div>`;
    }
    hooksLane =
      `<section class="cat hooks"><h2>hooks <span class="n">(${hooks.length})</span> — by lifecycle event</h2>${lanes}</section>`;
  }

  // ---- legend (honest about usage signal) ----
  const usageLegend = hasUsage
    ? `<div class="legend-row"><strong>Usage tint:</strong> ` +
      `<span class="sw" style="box-shadow:inset 0 0 0 4px ${SEV_TINT["🔴"]}"></span> stale&costly ` +
      `<span class="sw" style="box-shadow:inset 0 0 0 4px ${SEV_TINT["🟠"]}"></span> cold-idle ` +
      `<span class="sw" style="box-shadow:inset 0 0 0 4px ${SEV_TINT["🟡"]}"></span> warm-idle ` +
      `<span class="sw" style="box-shadow:inset 0 0 0 4px ${SEV_TINT["⚪"]}"></span> info/no-signal</div>` +
      `<div class="legend-note">Usage is a best-effort signal from undocumented local logs; ` +
      `it may undercount, and "never seen" is a prompt to review, not proof of non-use.</div>`
    : `<div class="legend-note">No usage.json present — tiles show cost &amp; status only. ` +
      `Run <code>/vault-usage</code> to add an idle-severity tint.</div>`;

  const generatedAt = esc(vault?.generatedAt || "unknown");
  const scope = esc(vault?.scope || "unknown");
  const root = esc(vault?.root || "unknown");
  const total = resources.length;

  const catCountStr = CATEGORY_ORDER
    .filter((c) => catCounts[c] > 0)
    .map((c) => `${c} ${catCounts[c]}`)
    .join(" · ");
  const costCountStr = COST_ORDER.map((c) => `${c} ${costCounts[c]}`).join(" · ");

  // ---- assemble document (inline CSS/JS only; no external refs) ----
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vault map — ${scope}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1115; color: #e6e6e6; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .meta { color: #9aa0a6; font-size: 12px; margin-bottom: 4px; }
  header .counts { color: #c3c8cf; font-size: 12px; margin-bottom: 16px; }
  .legend { background: #161922; border: 1px solid #232838; border-radius: 8px; padding: 12px 14px; margin-bottom: 20px; }
  .legend-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .legend-row .sw { display: inline-block; width: 18px; height: 18px; border-radius: 4px; background: #2a2f3a; }
  .legend-note { color: #9aa0a6; font-size: 12px; }
  .legend code { background: #232838; padding: 1px 5px; border-radius: 4px; }
  section.cat { margin-bottom: 24px; }
  section.cat h2 { font-size: 15px; margin: 0 0 10px; text-transform: capitalize; }
  section.cat h2 .n { color: #9aa0a6; font-weight: 400; }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .tile { border-radius: 8px; padding: 8px; display: flex; flex-direction: column; justify-content: space-between; color: #fff; overflow: hidden; cursor: default; }
  .tile .tname { font-weight: 600; font-size: 12px; word-break: break-word; }
  .tile .tmeta { font-size: 10px; opacity: .85; }
  .tile .tuse { font-size: 10px; opacity: .9; margin-top: 2px; }
  .hooks .lane { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .hooks .lane-label { width: 150px; flex: none; color: #c3c8cf; font-size: 12px; font-weight: 600; }
  .hooks .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .hooks .chip { padding: 4px 8px; border-radius: 6px; color: #fff; font-size: 12px; }
  footer { color: #6b7280; font-size: 11px; margin-top: 24px; border-top: 1px solid #232838; padding-top: 12px; }
</style>
</head>
<body>
<header>
  <h1>Environment map — ${scope}</h1>
  <div class="meta">${root} · inventory generated ${generatedAt} · ${total} resources</div>
  <div class="counts">By category: ${esc(catCountStr)} &nbsp;|&nbsp; By cost: ${esc(costCountStr)}</div>
</header>
<div class="legend">
  <div class="legend-row"><strong>Tile area</strong> ∝ context cost (HIGH largest → ZERO smallest).
    <strong style="margin-left:12px">Color</strong> = status:
    <span class="sw" style="background:${STATUS_COLOR.active}"></span> active
    <span class="sw" style="background:${STATUS_COLOR.disabled}"></span> disabled
    <span class="sw" style="background:${STATUS_COLOR.inferred}"></span> inferred
  </div>
  ${usageLegend}
</div>
<main>
  ${sections}
  ${hooksLane}
</main>
<footer>Generated by claude-vault /vault-map · self-contained, offline. No external resources, no secrets embedded.</footer>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args);
  const vault = safeJSON(join(root, "vault.json"));
  if (!vault) {
    process.stderr.write(`build-map.mjs: vault.json not found or invalid at ${root}. Run /vault-refresh first.\n`);
    process.exit(2);
  }
  const usage = safeJSON(join(root, "usage.json")); // may be null
  const html = build(vault, usage);

  if (args.stdout) {
    process.stdout.write(html);
    return;
  }
  const outPath = join(root, "vault-map.html");
  writeFileSync(outPath, html);
  process.stdout.write(JSON.stringify({ ok: true, written: outPath, hasUsage: usage != null }) + "\n");
}

main();

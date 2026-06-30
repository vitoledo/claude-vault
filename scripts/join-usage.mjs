#!/usr/bin/env node
/**
 * join-usage.mjs
 *
 * Deterministic usage JOIN engine for the /vault-usage command (Wave 2).
 *
 * This is the second half of the usage pipeline. crunch-usage.mjs produces RAW
 * per-name evidence; this script consumes that evidence PLUS vault.json and does
 * everything semantic the command used to improvise by hand:
 *   - normalize raw log names to vault resource names (§U.3),
 *   - join evidence to every vault resource by name (§U.3),
 *   - compute days-idle + recency tier and apply the idle-severity model (§U.4),
 *   - write usage.json (the canonical behavioral layer /vault-prune consumes),
 *   - print a compact, already-grouped, report-ready summary to stdout.
 *
 * It runs crunch-usage.mjs internally (ONCE) so the command calls a single
 * bundled script and never writes a throwaway join script at runtime. This is the
 * usage-side analogue of how /vault-doctor calls check-references.mjs.
 *
 * Severity is recency GATED by context cost (§U.4), never recency alone. Critically,
 * it also distinguishes "confidently idle" (has a real lastUsed signal that went cold)
 * from "never seen" (no log evidence at all) — the latter is NOT an alarm:
 *   - HIGH / MED, observed in logs  : ACTIVE=⚪ · WARM-IDLE=🟡 · COLD-IDLE=🟠 · STALE(≥90d)=🔴
 *   - HIGH / MED, NEVER seen in logs: ⚪ INFO — "no usage signal" (surfaced for review, never
 *                                     alarmed as confirmed-stale; absence is not proof of non-use)
 *   - LOW / ZERO (user commands, disable-model-invocation skills, *-disabled)  : always ⚪
 *   - hooks & rules (always-on, no per-use log signal)                          : always ⚪
 *   - mcp servers with status "inferred" (catalog-only, not loaded)             : always ⚪
 * Only 🔴/🟠/🟡 (signal-backed idle) are auto-proposed by /vault-prune; the no-signal
 * costly set is reported separately and disabled only if the user explicitly asks.
 *
 * HARD CONSTRAINTS:
 *   - Reads only vault.json and the crunch output. Never opens logs or secrets
 *     directly — crunch-usage.mjs owns log reading (and never touches secrets, §0.10).
 *   - "never seen" / "no signal" is surfaced for review, never asserted as proof of
 *     non-use (§U honesty mandate). The signal field records which case applies.
 *   - Deterministic: same inputs -> same usage.json. Pass --today for reproducibility.
 *
 * Usage:
 *   node join-usage.mjs                       # project-first, then global
 *   node join-usage.mjs --root /path/to/.claude
 *   node join-usage.mjs --scope global
 *   node join-usage.mjs --vault /path/to/vault.json
 *   node join-usage.mjs --crunch /path/to/crunch.json   # reuse evidence, skip re-run
 *   node join-usage.mjs --today 2026-06-23T17:00:00Z    # pin "now" (testing)
 *
 * Output shape (stdout): a compact, report-ready summary —
 *   {
 *     "ok": true,
 *     "usageJson": "<path written>",
 *     "scope": "project|global",
 *     "root": "<.claude path>",
 *     "vaultGeneratedAt": "<ISO>",
 *     "latestLogISO": "<ISO|null>",
 *     "logCoverage": { "linesParsed": <int>, "linesSkipped": <int> },
 *     "counts": { "🔴": N, "🟠": N, "🟡": N, "⚪": N, "activeObserved": N, "total": N },
 *     "candidates": [ <row>, ... ],       // the 🔴/🟠/🟡 rows, most-actionable first
 *     "activeObserved": [ <row>, ... ],   // HIGH/MED resources used in the last 30d
 *     "infoByCategory": { "<category>": N, ... }   // breakdown of the ⚪ bucket
 *   }
 * On a missing inventory it prints { "ok": false, "reason": "vault-missing", "root", "vaultPath" }
 * and exits 0, so the command can offer to run /vault-refresh.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;
const IDLE = { WARM: 30, COLD: 60, STALE: 90 }; // day thresholds (§U.4)

// --- args + root resolution (mirror the sibling scripts) --------------------
function parseArgs(argv) {
  const args = { scope: null, root: null, vault: null, crunch: null, today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") args.scope = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--vault") args.vault = argv[++i];
    else if (a === "--crunch") args.crunch = argv[++i];
    else if (a === "--today") args.today = argv[++i];
  }
  return args;
}
function resolveRoot({ scope, root }) {
  if (root) return root;
  const projectRoot = join(process.cwd(), ".claude");
  const globalRoot = join(homedir(), ".claude");
  if (scope === "global") return globalRoot;
  if (scope === "project") return projectRoot;
  return existsSync(projectRoot) ? projectRoot : globalRoot;
}

// --- §U.3 normalization: map one raw evidence name to candidate vault names --
// Returns every vault name this evidence could legitimately attach to. We are
// generous on candidates but the join itself stays exact (a candidate only
// matches a vault resource that actually carries that name).
function candidateNames(raw) {
  const out = new Set([raw]);
  if (raw.startsWith("/")) out.add(raw.slice(1)); // "/vault-doctor" -> "vault-doctor"
  if (raw.includes(":")) out.add(raw.split(":").pop()); // "claude-vault:vault-auditor" -> "vault-auditor"
  if (raw.includes("/")) out.add(raw.split("/").pop()); // "claude-vault/vault-auditor" -> "vault-auditor"
  // mcp tool / server forms -> server-level vault mcp name (§U.3)
  const m = raw.match(/^mcp__([A-Za-z0-9-]+)(?:__|$)/);
  if (m) out.add(m[1]);
  // claude-mem ships its search server under a plugin-namespaced mcp prefix
  if (raw.startsWith("mcp__plugin_claude-mem")) out.add("claude-mem");
  return [...out];
}

// Fold all crunch evidence into candidate -> { lastUsedISO (max), count (sum) }.
function indexEvidence(events) {
  const byCandidate = new Map();
  for (const [raw, ev] of Object.entries(events || {})) {
    const last = ev.lastUsedISO || null;
    const count = ev.count || 0;
    for (const cand of candidateNames(raw)) {
      const prev = byCandidate.get(cand);
      if (!prev) byCandidate.set(cand, { lastUsedISO: last, count });
      else {
        if (last && (!prev.lastUsedISO || last > prev.lastUsedISO)) prev.lastUsedISO = last;
        prev.count += count;
      }
    }
  }
  return byCandidate;
}

// A vault resource matches evidence by its own name; plugins also match the bare
// slug of "slug@marketplace" (the log never carries the marketplace).
function matchEvidence(res, byCandidate) {
  if (byCandidate.has(res.name)) return byCandidate.get(res.name);
  if (res.category === "plugin") {
    const slug = String(res.name).split("@")[0];
    if (byCandidate.has(slug)) return byCandidate.get(slug);
  }
  return null;
}

// --- §U.4 recency tier + cost-gated severity --------------------------------
function daysIdleFrom(lastUsedISO, nowMs) {
  if (!lastUsedISO) return null;
  const t = Date.parse(lastUsedISO);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}
function recencyTier(daysIdle, signal) {
  if (signal === "no-signal" || daysIdle == null) return "NEVER";
  if (daysIdle < IDLE.WARM) return "ACTIVE";
  if (daysIdle < IDLE.COLD) return "WARM-IDLE";
  if (daysIdle < IDLE.STALE) return "COLD-IDLE";
  return "STALE";
}
function isCostly(res) {
  return res.contextCostClass === "HIGH" || res.contextCostClass === "MED";
}
// True when a resource taxes context AND is actually loaded (so idleness matters).
function isCostlyLoaded(res) {
  if (res.status === "disabled") return false;
  if (!isCostly(res)) return false;
  if (res.category === "hook" || res.category === "rule") return false; // always-on, no per-use signal
  if (res.category === "mcp" && res.status === "inferred") return false; // catalog-only, not loaded
  return true;
}
// Returns "🔴|🟠|🟡|⚪" (usage.json severity stays in this 4-glyph set).
// no-signal NEVER escalates: "never seen" is not proof of non-use, so it stays ⚪ and is
// surfaced separately for review — only a real lastUsed signal that went cold earns 🔴/🟠/🟡.
function severityFor(res, tier, signal) {
  if (!isCostlyLoaded(res)) return "⚪";
  if (signal !== "observed") return "⚪"; // no usage signal -> INFO, never an alarm
  switch (tier) {
    case "WARM-IDLE": return "🟡";
    case "COLD-IDLE": return "🟠";
    case "STALE": return "🔴"; // observed once, now >=90d cold -> confidently idle
    case "ACTIVE":
    default: return "⚪"; // seen in the last 30d -> healthy, not a candidate
  }
}
// Healthy-and-used highlight: a costly resource actually seen in the last 30 days.
function isActiveObserved(res, tier, signal) {
  return isCostlyLoaded(res) && signal === "observed" && tier === "ACTIVE";
}
// Costly resource with NO log evidence at all — review candidate, not a confirmed-stale alarm.
function isNoSignalCostly(res, signal) {
  return isCostlyLoaded(res) && signal === "no-signal";
}

const SEV_RANK = { "🔴": 0, "🟠": 1, "🟡": 2, "⚪": 3 };
const COST_RANK = { HIGH: 0, MED: 1, LOW: 2, ZERO: 3 };

function row(r) {
  return {
    name: r.name,
    category: r.category,
    contextCostClass: r.contextCostClass,
    status: r.status,
    lastUsedISO: r.lastUsedISO,
    daysIdle: r.daysIdle,
    count: r.count,
    signal: r.signal,
    recencyTier: r.recencyTier,
    severity: r.severity,
    disableMechanism: r.disableMechanism,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args);
  const nowMs = args.today ? Date.parse(args.today) : Date.now();
  const vaultPath = args.vault || join(root, "vault.json");

  if (!existsSync(vaultPath)) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "vault-missing", root, vaultPath }, null, 2) + "\n"
    );
    return;
  }

  let vault;
  try {
    vault = JSON.parse(readFileSync(vaultPath, "utf8"));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "vault-unreadable", vaultPath, error: String(err) }, null, 2) + "\n"
    );
    return;
  }
  const resources = Array.isArray(vault.resources) ? vault.resources : [];

  // crunch the logs (reuse a provided file, else run the bundled cruncher once)
  let crunch;
  if (args.crunch) {
    crunch = JSON.parse(readFileSync(args.crunch, "utf8"));
  } else {
    const crunchPath = join(HERE, "crunch-usage.mjs");
    const out = execSync(`node "${crunchPath}" --root "${root}"`, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    crunch = JSON.parse(out);
  }
  const byCandidate = indexEvidence(crunch.events);

  // join + grade every resource
  const graded = resources.map((res) => {
    const ev = matchEvidence(res, byCandidate);
    const signal = ev ? "observed" : "no-signal";
    const lastUsedISO = ev ? ev.lastUsedISO : null;
    const daysIdle = daysIdleFrom(lastUsedISO, nowMs);
    const tier = recencyTier(daysIdle, signal);
    const severity = severityFor(res, tier, signal);
    return {
      name: res.name,
      category: res.category,
      contextCostClass: res.contextCostClass,
      status: res.status,
      disableMechanism: res.disableMechanism,
      lastUsedISO,
      daysIdle,
      count: ev ? ev.count : 0,
      recencyTier: tier,
      severity,
      signal,
      _activeObserved: isActiveObserved(res, tier, signal),
      _noSignalCostly: isNoSignalCostly(res, signal),
    };
  });

  // write usage.json (canonical behavioral layer, joinable by name)
  const usage = {
    generatedAt: new Date().toISOString(),
    scope: vault.scope || (root === join(process.cwd(), ".claude") ? "project" : "global"),
    root,
    vaultGeneratedAt: vault.generatedAt || null,
    latestLogISO: crunch.latestLogISO || null,
    logCoverage: { linesParsed: crunch.linesParsed || 0, linesSkipped: crunch.linesSkipped || 0 },
    resources: graded.map(({ _activeObserved, _noSignalCostly, ...r }) => r),
  };
  const usagePath = join(dirname(vaultPath), "usage.json");
  writeFileSync(usagePath, JSON.stringify(usage, null, 2));

  // build the compact, report-ready summary
  const candidates = graded
    .filter((r) => r.severity !== "⚪")
    .sort(
      (a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        COST_RANK[a.contextCostClass] - COST_RANK[b.contextCostClass] ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name)
    )
    .map(row);
  const activeObserved = graded
    .filter((r) => r._activeObserved)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map(row);
  // Costly resources with no log evidence: review candidates, reported apart from the
  // signal-backed 🔴/🟠/🟡 set so "never seen" is never dressed up as confirmed-stale.
  const noSignalCostly = graded
    .filter((r) => r._noSignalCostly)
    .sort(
      (a, b) =>
        COST_RANK[a.contextCostClass] - COST_RANK[b.contextCostClass] ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name)
    )
    .map(row);
  const infoByCategory = {};
  for (const r of graded) {
    if (r.severity === "⚪") infoByCategory[r.category] = (infoByCategory[r.category] || 0) + 1;
  }
  const counts = {
    "🔴": 0, "🟠": 0, "🟡": 0, "⚪": 0,
    activeObserved: activeObserved.length,
    noSignalCostly: noSignalCostly.length,
    total: graded.length,
  };
  for (const r of graded) counts[r.severity]++;
  // disjoint slice of the ⚪ bucket (⚪ also contains activeObserved + noSignalCostly),
  // so the report header buckets sum to total without the model doing arithmetic.
  counts.info = counts["⚪"] - activeObserved.length - noSignalCostly.length;

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        usageJson: usagePath,
        scope: usage.scope,
        root,
        vaultGeneratedAt: usage.vaultGeneratedAt,
        latestLogISO: usage.latestLogISO,
        logCoverage: usage.logCoverage,
        counts,
        candidates,
        activeObserved,
        noSignalCostly,
        infoByCategory,
      },
      null,
      2
    ) + "\n"
  );
}

main();

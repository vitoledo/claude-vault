#!/usr/bin/env node
/**
 * crunch-usage.mjs
 *
 * Deterministic usage log-cruncher for the /vault-usage command (Wave 2).
 *
 * Walks Claude Code's local logs and tallies, PER RAW NAME, the evidence of use:
 *   - lastUsedISO   (most recent timestamp seen)
 *   - firstSeenISO  (earliest timestamp seen)
 *   - count         (number of evidence events)
 *   - sources       (which log streams produced the evidence)
 *
 * It emits ONE raw JSON object to stdout. It decides NOTHING semantic: no severity,
 * no recency tier, no join to vault.json, no normalization to vault names. The
 * command owns all of that (§U.3, §U.4). This script's only job is cheap,
 * deterministic, resilient tallying of raw evidence.
 *
 * Data sources (§U.2), all best-effort:
 *   - history.jsonl            -> slash commands the user typed ("/enrich", ...)
 *   - projects/<...>.jsonl      -> per-session events: tool_use names (incl.
 *                                 mcp__<server>__<tool>), Task/subagent invocations,
 *                                 skill activations/listings
 *   - metrics/costs.jsonl       -> optional cost signal, if present
 *
 * HARD CONSTRAINTS:
 *   - NEVER reads .credentials.json or any secret (§0.10). It only opens the three
 *     log sources above; nothing else.
 *   - Resilient to malformed/rotated lines: skip-and-continue, never throw on a bad
 *     line. A corrupt line must not abort the run (§U.9 case 6).
 *   - Streams files line-by-line (handles large logs without loading whole file).
 *   - Cross-platform (node:path + node:os; project-first then global like siblings).
 *
 * Usage:
 *   node crunch-usage.mjs                  # project-first, then global
 *   node crunch-usage.mjs --root /path/to/.claude
 *   node crunch-usage.mjs --scope global
 *
 * Output shape (stdout):
 *   {
 *     "generatedAt": "<ISO>",
 *     "root": "<.claude path>",
 *     "latestLogISO": "<max timestamp seen across all logs, or null>",
 *     "linesParsed": <int>,
 *     "linesSkipped": <int>,
 *     "events": {
 *       "<rawName>": {
 *         "count": <int>,
 *         "firstSeenISO": "<ISO|null>",
 *         "lastUsedISO": "<ISO|null>",
 *         "sources": ["history|projects|costs", ...],
 *         "kinds": ["slash|tool_use|mcp_tool|task|skill", ...]
 *       }
 *     }
 *   }
 */

import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";

// --- args + root resolution (mirror the other scripts) ----------------------
function parseArgs(argv) {
  const args = { scope: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scope") args.scope = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i];
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

// --- evidence accumulator ---------------------------------------------------
function makeStore() {
  return {
    events: Object.create(null),
    latestLogMs: null,
    linesParsed: 0,
    linesSkipped: 0,
  };
}

function record(store, rawName, kind, source, tsMs) {
  if (!rawName) return;
  let e = store.events[rawName];
  if (!e) {
    e = { count: 0, firstSeenMs: null, lastUsedMs: null, sources: new Set(), kinds: new Set() };
    store.events[rawName] = e;
  }
  e.count++;
  e.sources.add(source);
  e.kinds.add(kind);
  if (Number.isFinite(tsMs)) {
    if (e.firstSeenMs === null || tsMs < e.firstSeenMs) e.firstSeenMs = tsMs;
    if (e.lastUsedMs === null || tsMs > e.lastUsedMs) e.lastUsedMs = tsMs;
    if (store.latestLogMs === null || tsMs > store.latestLogMs) store.latestLogMs = tsMs;
  }
}

// --- timestamp extraction: tolerate several common field names --------------
function extractTsMs(obj) {
  const cand =
    obj.timestamp ?? obj.time ?? obj.ts ?? obj.date ?? obj.createdAt ?? obj.created_at ?? null;
  if (cand == null) return NaN;
  if (typeof cand === "number") {
    // epoch seconds vs ms heuristic
    return cand < 1e12 ? cand * 1000 : cand;
  }
  const t = Date.parse(cand);
  return Number.isNaN(t) ? NaN : t;
}

// --- line readers (skip-and-continue on any malformed line) -----------------
async function streamLines(filePath, onObj, store) {
  if (!existsSync(filePath)) return;
  let rl;
  try {
    rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
  } catch {
    return; // unreadable file -> treat as absent, don't abort
  }
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      store.linesSkipped++;
      continue; // malformed/rotated line: skip, keep going (§U.9 case 6)
    }
    store.linesParsed++;
    try {
      onObj(obj);
    } catch {
      // a handler hiccup on one weird shape must not kill the run
      store.linesSkipped++;
    }
  }
}

// --- history.jsonl: slash commands typed by the user ------------------------
function handleHistory(store) {
  return (obj) => {
    const ts = extractTsMs(obj);
    // history entries usually carry a "display"/"command"/"text" of what was typed
    const text =
      obj.display ?? obj.command ?? obj.text ?? obj.input ?? obj.prompt ?? "";
    if (typeof text !== "string") return;
    const m = text.trim().match(/^\/([A-Za-z0-9][\w-]*)/);
    if (m) record(store, m[1], "slash", "history", ts);
  };
}

// --- projects/*.jsonl: tool_use, Task/subagent, skill events ----------------
function handleProject(store) {
  return (obj) => {
    const ts = extractTsMs(obj);
    walkForEvents(obj, store, ts, 0, new WeakSet());
  };
}

// Recursively scan a session record for the event shapes we care about.
// Defensive: any field may be missing or a different type. A WeakSet of visited
// nodes prevents counting the same object twice if it is referenced from more
// than one place in the record graph.
function walkForEvents(node, store, ts, depth = 0, seen) {
  if (node == null || typeof node !== "object" || depth > 8) return;
  if (seen) {
    if (seen.has(node)) return;
    seen.add(node);
  }

  // tool_use blocks: { type:"tool_use", name:"..." }
  const type = node.type;
  if (type === "tool_use" && typeof node.name === "string") {
    classifyToolName(store, node.name, ts);
  }
  // Subagent attribution — record at most ONCE per node, from whichever field
  // carries it, so overlapping shapes (Task tool_use whose input also has the
  // field, etc.) cannot double-count.
  let subagentName = null;
  if (type === "tool_use" && node.name === "Task" && node.input && typeof node.input === "object") {
    subagentName = node.input.subagent_type ?? node.input.subagentType ?? node.input.agent ?? null;
  }
  if (!subagentName && typeof node.subagent_type === "string") subagentName = node.subagent_type;
  if (!subagentName && typeof node.agent === "string" && type !== "tool_use") subagentName = node.agent;
  if (typeof subagentName === "string" && subagentName) {
    record(store, subagentName, "task", "projects", ts);
  }
  // skill activation events
  if ((type === "skill" || type === "skill_use" || node.skill) && typeof (node.skill ?? node.name) === "string") {
    const sname = node.skill ?? node.name;
    if (typeof sname === "string") record(store, sname, "skill", "projects", ts);
  }

  // recurse into arrays/objects (message.content[], events[], etc.).
  // Skip a Task tool_use's `input` — we already harvested its subagent above,
  // and descending would re-record the bare subagent_type field as a second event.
  const skipInput = type === "tool_use" && node.name === "Task";
  for (const key of Object.keys(node)) {
    if (skipInput && key === "input") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) walkForEvents(item, store, ts, depth + 1, seen);
    } else if (v && typeof v === "object") {
      walkForEvents(v, store, ts, depth + 1, seen);
    }
  }
}

// mcp__<server>__<tool> -> record BOTH the raw tool name and the server.
// The command will normalize mcp__github__search to vault mcp "github" (§U.3),
// but we surface the raw name too so nothing is lost.
function classifyToolName(store, name, ts) {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1];
    if (server) record(store, `mcp__${server}`, "mcp_tool", "projects", ts);
    record(store, name, "mcp_tool", "projects", ts);
  } else {
    record(store, name, "tool_use", "projects", ts);
  }
}

// --- metrics/costs.jsonl: optional, attribute by name if present ------------
function handleCosts(store) {
  return (obj) => {
    const ts = extractTsMs(obj);
    const name = obj.name ?? obj.resource ?? obj.tool ?? null;
    if (typeof name === "string") record(store, name, "cost", "costs", ts);
  };
}

// --- serialize ---------------------------------------------------------------
function serialize(store, root) {
  const events = {};
  for (const [name, e] of Object.entries(store.events)) {
    events[name] = {
      count: e.count,
      firstSeenISO: e.firstSeenMs === null ? null : new Date(e.firstSeenMs).toISOString(),
      lastUsedISO: e.lastUsedMs === null ? null : new Date(e.lastUsedMs).toISOString(),
      sources: [...e.sources],
      kinds: [...e.kinds],
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    root,
    latestLogISO: store.latestLogMs === null ? null : new Date(store.latestLogMs).toISOString(),
    linesParsed: store.linesParsed,
    linesSkipped: store.linesSkipped,
    events,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args);
  const store = makeStore();

  if (!existsSync(root)) {
    process.stdout.write(JSON.stringify(serialize(store, root), null, 2) + "\n");
    return;
  }

  // history.jsonl (slash commands)
  await streamLines(join(root, "history.jsonl"), handleHistory(store), store);

  // projects/*.jsonl (session events) — only this directory, nothing else
  const projectsDir = join(root, "projects");
  if (existsSync(projectsDir)) {
    let entries = [];
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      // projects may nest per-project subfolders; handle one level + flat files
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        await streamLines(join(projectsDir, ent.name), handleProject(store), store);
      } else if (ent.isDirectory()) {
        let sub = [];
        try {
          sub = await readdir(join(projectsDir, ent.name));
        } catch {
          sub = [];
        }
        for (const f of sub) {
          if (f.endsWith(".jsonl")) {
            await streamLines(join(projectsDir, ent.name, f), handleProject(store), store);
          }
        }
      }
    }
  }

  // metrics/costs.jsonl (optional)
  await streamLines(join(root, "metrics", "costs.jsonl"), handleCosts(store), store);

  process.stdout.write(JSON.stringify(serialize(store, root), null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`crunch-usage.mjs failed: ${err.stack || err}\n`);
  process.exit(1);
});

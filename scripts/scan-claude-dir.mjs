#!/usr/bin/env node
/**
 * scan-claude-dir.mjs
 *
 * Deterministic enumeration of a Claude Code environment directory.
 *
 * Walks a project `.claude/` (default) or the global `~/.claude/`, reads the
 * frontmatter of agents/skills/commands, enumerates rules/ (recursively) and
 * projects/ (directory names only), parses settings.json (enabledPlugins,
 * hooks), installed_plugins.json, and mcp-configs/*, and emits a single raw
 * JSON object to stdout.
 *
 * It does NOT decide contextCostClass, disableMechanism, or status semantics —
 * the vault-auditor agent curates this raw output into the §0.6 vault.json
 * schema. The script's only job is cheap, deterministic discovery.
 *
 * NEVER reads or emits secrets (.credentials.json, env values, tokens).
 *
 * Usage:
 *   node scan-claude-dir.mjs                 # project-first, then global
 *   node scan-claude-dir.mjs --scope global  # force ~/.claude/
 *   node scan-claude-dir.mjs --scope project # force ./.claude/
 *   node scan-claude-dir.mjs --root /path/to/.claude
 *
 * Cross-platform: uses node:path + node:os, tolerant of Windows + POSIX paths.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { homedir } from "node:os";

// --- §0.10 ignore-list: runtime dirs and files never relevant to inventory ---
const IGNORE_DIRS = new Set([
  "cache", "daemon", "debug", "file-history", "metrics", "session-data",
  "session-env", "sessions", "shell-snapshots", "telemetry", "backups",
  "ide", "downloads",
]);
const IGNORE_FILE_PATTERNS = [
  /\.log$/i,
  /^history\.jsonl$/i,
  /-cache\.json$/i,
  /^\.last-cleanup$/i,
  /^\.credentials\.json$/i, // NEVER read secrets
];

function isIgnoredDir(name) {
  return IGNORE_DIRS.has(name);
}
function isIgnoredFile(name) {
  return IGNORE_FILE_PATTERNS.some((re) => re.test(name));
}

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const args = { scope: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scope") args.scope = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i];
  }
  return args;
}

// --- root resolution (§0.5: project-first, then global) ---------------------
function resolveRoot({ scope, root }) {
  if (root) return { root, scope: "explicit" };
  const projectRoot = join(process.cwd(), ".claude");
  const globalRoot = join(homedir(), ".claude");
  if (scope === "global") return { root: globalRoot, scope: "global" };
  if (scope === "project") return { root: projectRoot, scope: "project" };
  // default: project-first, fall back to global
  if (existsSync(projectRoot)) return { root: projectRoot, scope: "project" };
  return { root: globalRoot, scope: "global" };
}

// --- minimal, dependency-free YAML frontmatter parser -----------------------
// Handles the flat key: value frontmatter that subagents/skills/commands use.
// Supports scalar values and simple inline lists ([a, b, c]). Good enough for
// name/description/tools/model/disable-model-invocation; the agent does the
// semantic interpretation.
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(3, end).trim();
  const out = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, "")) // strip per-item quotes
        .filter(Boolean);
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function safeReadFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function safeReadJSON(path) {
  const text = await safeReadFile(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: true, path };
  }
}

// --- enumerate markdown component dirs (agents, commands, skills) -----------
async function enumerateMarkdownDir(root, subdir, kind) {
  const dir = join(root, subdir);
  const results = [];
  if (!existsSync(dir)) return results;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // skills are typically <skill-name>/SKILL.md
      if (kind === "skill") {
        const skillFile = join(dir, entry.name, "SKILL.md");
        if (existsSync(skillFile)) {
          const text = await safeReadFile(skillFile);
          results.push({
            kind,
            file: relative(root, skillFile).split(sep).join("/"),
            dirName: entry.name,
            frontmatter: text ? parseFrontmatter(text) : null,
          });
        }
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (isIgnoredFile(entry.name)) continue;
    const file = join(dir, entry.name);
    const text = await safeReadFile(file);
    results.push({
      kind,
      file: relative(root, file).split(sep).join("/"),
      fileName: entry.name,
      frontmatter: text ? parseFrontmatter(text) : null,
    });
  }
  return results;
}

// --- detect *-disabled/ sibling folders -------------------------------------
async function enumerateDisabled(root, baseSubdir, kind) {
  const disabledDir = join(root, `${baseSubdir}-disabled`);
  const results = [];
  if (!existsSync(disabledDir)) return results;
  const found = await enumerateMarkdownDir(root, `${baseSubdir}-disabled`, kind);
  for (const r of found) {
    r.disabled = true;
    results.push(r);
  }
  return results;
}

// --- enumerate rules/ (recursive: rules nest under category subdirs) ---------
// Captures each .md file's relative path + its first markdown heading as a title,
// so the auditor gets a triggerOrDescription without extra per-file reads.
async function enumerateRules(root, subdir = "rules", out = []) {
  const dir = join(root, subdir);
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${subdir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      await enumerateRules(root, rel, out); // recurse into category subdirs
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (isIgnoredFile(entry.name)) continue;
    const text = await safeReadFile(join(root, rel));
    out.push({
      kind: "rule",
      file: rel,
      fileName: entry.name,
      title: text ? firstHeading(text) : null,
    });
  }
  return out;
}

// First markdown "# heading" in a file, else null. Cheap description source.
function firstHeading(text) {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = /^#{1,6}\s+(.*\S)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// --- enumerate projects/ (immediate subdir names ONLY — never read sessions) -
// projects/<dir>/*.jsonl are session transcripts (usage logs / potentially
// sensitive). We list project directory names for inventory and NEVER read them.
async function enumerateProjects(root) {
  const dir = join(root, "projects");
  const results = [];
  if (!existsSync(dir)) return results;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredDir(entry.name)) continue;
    results.push({
      kind: "project",
      name: entry.name,
      file: `projects/${entry.name}`,
    });
  }
  return results;
}

// --- main -------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root, scope } = resolveRoot(args);

  const raw = {
    generatedAt: new Date().toISOString(),
    scope,
    root,
    exists: existsSync(root),
    agents: [],
    commands: [],
    skills: [],
    rules: [],
    projects: [],
    plugins: { installed: null, enabled: null },
    hooks: [],
    mcp: [],
    notes: [],
  };

  if (!raw.exists) {
    raw.notes.push(`Root does not exist: ${root}`);
    process.stdout.write(JSON.stringify(raw, null, 2) + "\n");
    return;
  }

  // components (active + disabled)
  raw.agents = [
    ...(await enumerateMarkdownDir(root, "agents", "agent")),
    ...(await enumerateDisabled(root, "agents", "agent")),
  ];
  raw.commands = [
    ...(await enumerateMarkdownDir(root, "commands", "command")),
    ...(await enumerateDisabled(root, "commands", "command")),
  ];
  raw.skills = [
    ...(await enumerateMarkdownDir(root, "skills", "skill")),
    ...(await enumerateDisabled(root, "skills", "skill")),
  ];

  // rules/ (nested .md, possibly under category subdirs) and projects/ (dir names)
  raw.rules = await enumerateRules(root);
  raw.projects = await enumerateProjects(root);

  // settings.json: enabledPlugins + hooks
  const settings = await safeReadJSON(join(root, "settings.json"));
  if (settings && !settings.__parseError) {
    if (settings.enabledPlugins) raw.plugins.enabled = settings.enabledPlugins;
    if (settings.hooks) {
      raw.hooks = normalizeHooks(settings.hooks, "settings.json");
    }
  } else if (settings && settings.__parseError) {
    raw.notes.push("settings.json present but failed to parse.");
  }

  // hooks/hooks.json (alternative location)
  const hooksFile = await safeReadJSON(join(root, "hooks", "hooks.json"));
  if (hooksFile && !hooksFile.__parseError) {
    const extra = normalizeHooks(hooksFile.hooks ?? hooksFile, "hooks/hooks.json");
    raw.hooks.push(...extra);
  }

  // installed_plugins.json
  const installed = await safeReadJSON(join(root, "plugins", "installed_plugins.json"));
  if (installed && !installed.__parseError) raw.plugins.installed = installed;

  // mcp-configs/* and top-level .mcp.json
  raw.mcp = await enumerateMcp(root);

  process.stdout.write(JSON.stringify(raw, null, 2) + "\n");
}

// --- hook normalization: flatten to {event, command, source} ----------------
function normalizeHooks(hooksObj, source) {
  const out = [];
  if (Array.isArray(hooksObj)) {
    for (const h of hooksObj) {
      out.push({ event: h.event ?? null, command: h.command ?? null, source });
    }
    return out;
  }
  // object keyed by event name -> array of matcher/hooks entries
  for (const [event, entries] of Object.entries(hooksObj)) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const e of list) {
      const inner = e.hooks ?? e;
      const innerList = Array.isArray(inner) ? inner : [inner];
      for (const cmd of innerList) {
        out.push({
          event,
          command: cmd.command ?? cmd.type ?? null,
          source,
        });
      }
    }
  }
  return out;
}

// --- MCP enumeration --------------------------------------------------------
async function enumerateMcp(root) {
  const servers = [];

  // top-level .mcp.json
  const topMcp = await safeReadJSON(join(root, ".mcp.json"));
  if (topMcp && !topMcp.__parseError && topMcp.mcpServers) {
    for (const name of Object.keys(topMcp.mcpServers)) {
      servers.push({ name, source: ".mcp.json" });
    }
  }

  // mcp-configs/*.json
  const mcpDir = join(root, "mcp-configs");
  if (existsSync(mcpDir)) {
    let files;
    try {
      files = await readdir(mcpDir);
    } catch {
      files = [];
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const conf = await safeReadJSON(join(mcpDir, f));
      if (!conf || conf.__parseError) continue;
      const srvObj = conf.mcpServers ?? conf;
      if (srvObj && typeof srvObj === "object") {
        for (const name of Object.keys(srvObj)) {
          servers.push({ name, source: `mcp-configs/${f}` });
        }
      }
    }
  }
  return servers;
}

main().catch((err) => {
  process.stderr.write(`scan-claude-dir.mjs failed: ${err.stack || err}\n`);
  process.exit(1);
});

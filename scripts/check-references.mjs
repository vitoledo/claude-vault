#!/usr/bin/env node
/**
 * check-references.mjs
 *
 * Deterministic broken-reference detector for /vault-doctor detection #3 (🔴).
 *
 * Scans the bodies of every agent/command/skill markdown file under a Claude
 * Code environment directory for `@path` references, and resolves every hook
 * command/script path found in settings.json / hooks/hooks.json against the
 * filesystem. Emits a JSON list of references that do NOT resolve.
 *
 * Deterministic and token-cheap: keeps detection #3 out of the model's head.
 *
 * NEVER reads secrets (.credentials.json).
 *
 * Usage:
 *   node check-references.mjs                 # project-first, then global
 *   node check-references.mjs --root /path/to/.claude
 *
 * Output shape (stdout):
 *   {
 *     "root": "...",
 *     "checked": <int>,        // total references inspected
 *     "broken": [
 *       { "type": "at-path"|"hook-script", "ref": "...", "in": "agents/x.md", "resolvedFrom": "..." }
 *     ]
 *   }
 *
 * Cross-platform: node:path + node:os.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep, relative } from "node:path";
import { homedir } from "node:os";

const IGNORE_DIRS = new Set([
  "cache", "daemon", "debug", "file-history", "metrics", "session-data",
  "session-env", "sessions", "shell-snapshots", "telemetry", "backups",
  "ide", "downloads",
]);

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
    return null;
  }
}

// Recursively collect *.md bodies under the relevant component dirs.
async function collectMarkdown(root) {
  const files = [];
  const targets = [
    "agents", "agents-disabled",
    "commands", "commands-disabled",
    "skills", "skills-disabled",
  ];
  for (const t of targets) {
    const dir = join(root, t);
    if (!existsSync(dir)) continue;
    await walk(dir, files);
  }
  return files;
}

async function walk(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), acc);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      acc.push(join(dir, e.name));
    }
  }
}

// Remove fenced and inline code before scanning. Code blocks routinely contain
// `@scope/pkg` npm imports and `@/alias` path aliases that are NOT Claude context
// imports — scanning them produces false 🔴 "broken reference" findings.
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, "") // fenced blocks
    .replace(/~~~[\s\S]*?~~~/g, "") // alt fenced blocks
    .replace(/`[^`\n]*`/g, "");     // inline code spans
}

// Extract Claude `@path` context imports from a body. A genuine import points at
// a real file, so we REQUIRE a known file extension at the end of the token. That
// single rule excludes the two big false-positive classes:
//   - npm scoped packages: @tanstack/react-virtual, @testing-library/react  (no ext)
//   - import path aliases:  @/lib/supabase, @/components/ui                  (no ext)
// while still matching @./local.md, @../x/y.md, @~/.claude/CLAUDE.md,
// @rules/common/agents.md, @notes.txt, @RTK.md.
// The `(?<![\w@/])` lookbehind plus the extension allowlist both reject emails
// (user@gmail.com → preceded by a word char, and `.com` is not an allowed ext).
function extractAtPaths(text) {
  const refs = new Set();
  const re =
    /(?<![\w@/])@([~./\w][\w./-]*\.(?:md|markdown|txt|json|jsonc|mjs|cjs|js|ts|sh|py|yaml|yml|toml))/g;
  let m;
  while ((m = re.exec(stripCode(text))) !== null) {
    refs.add(m[1]);
  }
  return [...refs];
}

function resolveAtPath(ref, fileDir, root) {
  let candidate;
  if (ref.startsWith("~/")) {
    candidate = join(homedir(), ref.slice(2));
  } else if (isAbsolute(ref)) {
    candidate = ref;
  } else if (ref.startsWith("./") || ref.startsWith("../")) {
    candidate = resolve(fileDir, ref);
  } else {
    // bare relative like foo/bar.md — try relative to the file, then to root
    const fromFile = resolve(fileDir, ref);
    if (existsSync(fromFile)) return fromFile;
    candidate = resolve(root, ref);
  }
  return candidate;
}

// Pull candidate script paths out of a hook command string. We look for tokens
// ending in a script extension (.mjs/.js/.cjs/.sh/.ts/.py) and resolve them.
function extractHookScripts(command) {
  if (!command || typeof command !== "string") return [];
  const tokens = command.split(/\s+/);
  return tokens
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter((t) => /\.(mjs|js|cjs|sh|ts|py)$/i.test(t));
}

function collectHookCommands(hooksObj, source, acc) {
  if (!hooksObj) return;
  if (Array.isArray(hooksObj)) {
    for (const h of hooksObj) {
      if (h.command) acc.push({ command: h.command, source });
    }
    return;
  }
  for (const [, entries] of Object.entries(hooksObj)) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const e of list) {
      const inner = e.hooks ?? e;
      const innerList = Array.isArray(inner) ? inner : [inner];
      for (const cmd of innerList) {
        if (cmd.command) acc.push({ command: cmd.command, source });
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args);

  const result = { root, checked: 0, broken: [] };

  if (!existsSync(root)) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // 1. @path references inside markdown bodies
  const mdFiles = await collectMarkdown(root);
  for (const file of mdFiles) {
    const text = await safeReadFile(file);
    if (text === null) continue;
    const refs = extractAtPaths(text);
    const fileDir = dirname(file);
    const inRel = relative(root, file).split(sep).join("/");
    for (const ref of refs) {
      result.checked++;
      const resolved = resolveAtPath(ref, fileDir, root);
      if (!existsSync(resolved)) {
        result.broken.push({
          type: "at-path",
          ref,
          in: inRel,
          resolvedFrom: relative(root, resolved).split(sep).join("/"),
        });
      }
    }
  }

  // 2. hook script paths
  const hookCommands = [];
  const settings = await safeReadJSON(join(root, "settings.json"));
  if (settings?.hooks) collectHookCommands(settings.hooks, "settings.json", hookCommands);
  const hooksFile = await safeReadJSON(join(root, "hooks", "hooks.json"));
  if (hooksFile) collectHookCommands(hooksFile.hooks ?? hooksFile, "hooks/hooks.json", hookCommands);

  for (const { command, source } of hookCommands) {
    const scripts = extractHookScripts(command);
    for (const script of scripts) {
      result.checked++;
      // resolve relative to root; absolute/~ honored
      let candidate;
      if (script.startsWith("~/")) candidate = join(homedir(), script.slice(2));
      else if (isAbsolute(script)) candidate = script;
      else candidate = resolve(root, script);
      if (!existsSync(candidate)) {
        result.broken.push({
          type: "hook-script",
          ref: script,
          in: source,
          resolvedFrom: relative(root, candidate).split(sep).join("/"),
        });
      }
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`check-references.mjs failed: ${err.stack || err}\n`);
  process.exit(1);
});

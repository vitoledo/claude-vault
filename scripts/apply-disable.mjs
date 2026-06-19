#!/usr/bin/env node
/**
 * apply-disable.mjs
 *
 * Atomic, reversible executor for ONE disable action (/vault-prune, Wave 3).
 *
 * This is the only script in the suite that MUTATES the user's environment, so it
 * biases entirely toward safety and reversibility:
 *   - Performs exactly ONE reversible mutation per invocation.
 *   - File moves create the `*-disabled/` destination dir as needed.
 *   - settings.json / hooks.json edits are JSON-safe and PRECEDED by a timestamped
 *     backup whose path is returned.
 *   - Refuses plugin-skill and mcp mechanisms (returns guidance-only) per §P.3.
 *   - NEVER deletes anything. NEVER touches secrets.
 *   - Detects on-disk drift (target already moved / key already false) and skips
 *     instead of forcing (§P.4 stop-on-doubt).
 *
 * The COMMAND owns confirmation and the candidate ranking; this script owns the safe
 * write and emits the undo metadata for the ledger. It does NOT decide what to prune.
 *
 * Invocation (the command passes a single JSON action spec, via --spec or stdin):
 *   node apply-disable.mjs --spec '{"category":"agent","mechanism":"move",
 *       "target":"agents/foo.md","root":"/path/.claude","name":"foo"}'
 *   echo '<spec json>' | node apply-disable.mjs
 *   add --dry-run to validate + report the planned op WITHOUT writing.
 *
 * Action spec fields:
 *   - root      : absolute path to the .claude dir (required)
 *   - name      : vault resource name (for the result/ledger)
 *   - category  : agent|command|skill|plugin|hook|plugin-skill|mcp
 *   - mechanism : "move" | "settings-key" | "frontmatter-flag" | "hook-remove" |
 *                 "guidance"  (the command derives this from vault disableMechanism)
 *   - target    : for move        -> the relative source path ("agents/foo.md" or "skills/foo")
 *                 for settings-key-> the enabledPlugins key ("name@marketplace")
 *                 for frontmatter -> the relative SKILL.md / agent .md path
 *                 for hook-remove -> { file: "settings.json"|"hooks/hooks.json",
 *                                      event: "...", match: "<command substring>" }
 *
 * Output (stdout): a single JSON result:
 *   { ok, name, category, action, applied, dryRun, from, to, undo, backup, note }
 *   ok=false with a "note" when refused/guidance-only/drift-skipped.
 */

import {
  existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, copyFileSync,
} from "node:fs";
import { join, dirname, basename, isAbsolute, relative, sep } from "node:path";

// ---- spec parsing ----------------------------------------------------------
function parseArgs(argv) {
  const a = { spec: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spec") a.spec = argv[++i];
    else if (argv[i] === "--dry-run") a.dryRun = true;
  }
  return a;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8").trim();
  return s || null;
}

function fail(note, extra = {}) {
  return { ok: false, applied: false, note, ...extra };
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- mechanism: move (agent / command / skill-as-dir) ----------------------
function doMove(spec, dryRun) {
  const { root, target, category, name } = spec;
  const absSource = join(root, target);
  // destination: sibling "<base>-disabled/<leaf>"
  // target may be a file (agents/foo.md) or a dir (skills/foo)
  const parts = target.split(/[\\/]/);
  const baseDir = parts[0]; // agents | commands | skills
  const rest = parts.slice(1).join("/");
  const disabledBase = `${baseDir}-disabled`;
  const relDest = `${disabledBase}/${rest}`;
  const absDest = join(root, relDest);

  // drift checks (§P.4 stop-on-doubt)
  if (!existsSync(absSource)) {
    // maybe already disabled?
    if (existsSync(absDest)) {
      return fail(
        `Drift: source not found but destination exists — "${name}" appears already disabled. Skipped.`,
        { name, category, from: target, to: relDest }
      );
    }
    return fail(`Drift: source "${target}" does not exist on disk. Skipped.`, {
      name, category, from: target,
    });
  }
  if (existsSync(absDest)) {
    return fail(
      `Drift: destination "${relDest}" already exists. Refusing to overwrite. Skipped.`,
      { name, category, from: target, to: relDest }
    );
  }

  const undo = `Move "${relDest}" back to "${target}".`;
  if (dryRun) {
    return {
      ok: true, applied: false, dryRun: true, name, category,
      action: "move", from: target, to: relDest, undo, backup: null,
      note: `Would move ${target} -> ${relDest}`,
    };
  }

  mkdirSync(dirname(absDest), { recursive: true });
  renameSync(absSource, absDest);
  return {
    ok: true, applied: true, dryRun: false, name, category,
    action: "move", from: target, to: relDest, undo, backup: null,
    note: `Moved ${target} -> ${relDest}`,
  };
}

// ---- mechanism: settings-key (disable a whole plugin) ----------------------
function doSettingsKey(spec, dryRun) {
  const { root, target, name, category } = spec; // target = "name@marketplace"
  const settingsPath = join(root, "settings.json");
  if (!existsSync(settingsPath)) {
    return fail(`settings.json not found at ${settingsPath}. Skipped.`, { name, category });
  }
  let raw, json;
  try {
    raw = readFileSync(settingsPath, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    return fail(`settings.json is not valid JSON; refusing to edit. (${e.message})`, { name, category });
  }
  const cur = json.enabledPlugins?.[target];
  if (cur === false) {
    return fail(`Drift: enabledPlugins["${target}"] is already false. Skipped.`, {
      name, category, from: `enabledPlugins["${target}"]=${JSON.stringify(cur)}`,
    });
  }
  const undo = `Set enabledPlugins["${target}"]=true in settings.json (and delete the .bak once confident).`;
  if (dryRun) {
    return {
      ok: true, applied: false, dryRun: true, name, category,
      action: "settings-key", from: `enabledPlugins["${target}"]=${JSON.stringify(cur)}`,
      to: `enabledPlugins["${target}"]=false`, undo, backup: null,
      note: `Would set enabledPlugins["${target}"]=false (backup first)`,
    };
  }
  // backup BEFORE writing (§P.4)
  const backup = `${settingsPath}.${ts()}.bak`;
  copyFileSync(settingsPath, backup);

  if (!json.enabledPlugins || typeof json.enabledPlugins !== "object") json.enabledPlugins = {};
  json.enabledPlugins[target] = false;
  // preserve 2-space formatting + trailing newline
  writeFileSync(settingsPath, JSON.stringify(json, null, 2) + "\n");
  return {
    ok: true, applied: true, dryRun: false, name, category,
    action: "settings-key", from: `enabledPlugins["${target}"]=${JSON.stringify(cur)}`,
    to: `enabledPlugins["${target}"]=false`, undo,
    backup: relative(root, backup).split(sep).join("/"),
    note: `Set enabledPlugins["${target}"]=false; backup at ${basename(backup)}`,
  };
}

// ---- mechanism: frontmatter-flag (alt for user skill) ----------------------
function doFrontmatterFlag(spec, dryRun) {
  const { root, target, name, category } = spec; // target = relative SKILL.md path
  const absPath = join(root, target);
  if (!existsSync(absPath)) {
    return fail(`Drift: "${target}" not found. Skipped.`, { name, category, from: target });
  }
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return fail(`Cannot read "${target}": ${e.message}`, { name, category });
  }
  if (/^\s*disable-model-invocation\s*:\s*true\s*$/m.test(text)) {
    return fail(`Drift: "${target}" already has disable-model-invocation: true. Skipped.`, {
      name, category, from: target,
    });
  }
  if (!text.startsWith("---")) {
    return fail(
      `"${target}" has no frontmatter block to flag; consider the move mechanism instead. Skipped.`,
      { name, category }
    );
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return fail(`"${target}" frontmatter is not closed; refusing to edit. Skipped.`, { name, category });
  }
  const undo = `Remove the "disable-model-invocation: true" line from ${target}.`;
  if (dryRun) {
    return {
      ok: true, applied: false, dryRun: true, name, category,
      action: "frontmatter-flag", from: target, to: target, undo, backup: null,
      note: `Would add disable-model-invocation: true to ${target}`,
    };
  }
  const backup = `${absPath}.${ts()}.bak`;
  copyFileSync(absPath, backup);
  const insertAt = end; // just before the closing ---
  const newText = text.slice(0, insertAt) + "\ndisable-model-invocation: true" + text.slice(insertAt);
  writeFileSync(absPath, newText);
  return {
    ok: true, applied: true, dryRun: false, name, category,
    action: "frontmatter-flag", from: target, to: target, undo,
    backup: relative(root, backup).split(sep).join("/"),
    note: `Added disable-model-invocation: true to ${target}; backup at ${basename(backup)}`,
  };
}

// ---- mechanism: hook-remove (comment/remove a hook entry) ------------------
// We do this JSON-safely: remove the matching hook command entry from the parsed
// structure, prune now-empty arrays, back up first. "match" is a substring of the
// hook command to identify it.
function doHookRemove(spec, dryRun) {
  const { root, target, name, category } = spec; // target = {file, event, match}
  const t = typeof target === "object" ? target : null;
  if (!t || !t.file) {
    return fail(`hook-remove needs target {file,event,match}. Skipped.`, { name, category });
  }
  const filePath = join(root, t.file);
  if (!existsSync(filePath)) {
    return fail(`Drift: ${t.file} not found. Skipped.`, { name, category });
  }
  let raw, json;
  try {
    raw = readFileSync(filePath, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    return fail(`${t.file} is not valid JSON; refusing to edit. (${e.message})`, { name, category });
  }
  const hooksRoot = t.file.endsWith("hooks.json") ? (json.hooks ?? json) : json.hooks;
  if (!hooksRoot || typeof hooksRoot !== "object") {
    return fail(`No hooks object in ${t.file}. Skipped.`, { name, category });
  }
  // locate + remove matching command under the given event (or any event)
  let removed = 0;
  const events = t.event ? [t.event] : Object.keys(hooksRoot);
  for (const ev of events) {
    const list = hooksRoot[ev];
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      const inner = group.hooks ?? (Array.isArray(group) ? group : null);
      if (Array.isArray(inner)) {
        const before = inner.length;
        const kept = inner.filter(
          (h) => !(typeof h?.command === "string" && t.match && h.command.includes(t.match))
        );
        removed += before - kept.length;
        if (group.hooks) group.hooks = kept;
      }
    }
    // prune groups whose hooks became empty
    hooksRoot[ev] = list.filter((g) => {
      const inner = g.hooks ?? g;
      return Array.isArray(inner) ? inner.length > 0 : true;
    });
    if (hooksRoot[ev].length === 0) delete hooksRoot[ev];
  }
  if (removed === 0) {
    return fail(
      `Drift: no hook entry matching "${t.match}"${t.event ? ` under ${t.event}` : ""} found in ${t.file}. Skipped.`,
      { name, category }
    );
  }
  const undo = `Restore the removed hook entry in ${t.file} from the .bak backup.`;
  if (dryRun) {
    return {
      ok: true, applied: false, dryRun: true, name, category,
      action: "hook-remove", from: `${t.file}:${t.event ?? "*"}:${t.match}`, to: "(removed)",
      undo, backup: null, note: `Would remove ${removed} hook entr(y/ies) matching "${t.match}"`,
    };
  }
  const backup = `${filePath}.${ts()}.bak`;
  copyFileSync(filePath, backup);
  writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n");
  return {
    ok: true, applied: true, dryRun: false, name, category,
    action: "hook-remove", from: `${t.file}:${t.event ?? "*"}:${t.match}`, to: "(removed)",
    undo, backup: relative(root, backup).split(sep).join("/"),
    note: `Removed ${removed} hook entr(y/ies); backup at ${basename(backup)}`,
  };
}

// ---- mechanism: guidance (plugin-skill, mcp) -> never mutate ---------------
function doGuidance(spec) {
  const { category, name } = spec;
  if (category === "plugin-skill") {
    return {
      ok: false, applied: false, guidanceOnly: true, name, category,
      action: "none",
      note:
        "Plugin skills are not individually disableable. To stop it, disable the whole " +
        "parent plugin (enabledPlugins[\"<plugin>@<marketplace>\"]=false) — a separate, " +
        "confirmed action.",
    };
  }
  // mcp
  return {
    ok: false, applied: false, guidanceOnly: true, name, category: "mcp",
    action: "none",
    note:
      "MCP servers have no reliable per-server toggle. To disable: run /mcp to review " +
      "servers, then edit the server's entry in your mcp config (mcp-configs/ or .mcp.json). " +
      "Not mutated automatically.",
  };
}

// ---- dispatch ---------------------------------------------------------------
function execute(spec, dryRun) {
  if (!spec || typeof spec !== "object") return fail("No valid action spec provided.");
  if (!spec.root || !isAbsolute(spec.root)) return fail("spec.root must be an absolute path.");
  switch (spec.mechanism) {
    case "move": return doMove(spec, dryRun);
    case "settings-key": return doSettingsKey(spec, dryRun);
    case "frontmatter-flag": return doFrontmatterFlag(spec, dryRun);
    case "hook-remove": return doHookRemove(spec, dryRun);
    case "guidance": return doGuidance(spec);
    default:
      return fail(`Unknown mechanism "${spec.mechanism}".`, { name: spec.name, category: spec.category });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let specText = args.spec ?? (await readStdin());
  if (!specText) {
    process.stdout.write(JSON.stringify(fail("No spec given (use --spec or stdin).")) + "\n");
    process.exit(0);
  }
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch (e) {
    process.stdout.write(JSON.stringify(fail(`Spec is not valid JSON: ${e.message}`)) + "\n");
    process.exit(0);
  }
  const result = execute(spec, args.dryRun);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`apply-disable.mjs failed: ${err.stack || err}\n`);
  process.exit(1);
});

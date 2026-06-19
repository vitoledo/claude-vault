# Conventions (§0)

The agent and command bodies in this plugin cite shared rules by section number
(e.g. "§0.5", "§0.7"). Those numbers resolve here. This file is the single source of
truth for the plugin's foundation; the bodies inline what they need and reference this
document so an external reader can always resolve a citation.

## §0.1 Plugin identity
- name: `claude-vault`
- A per-user governance kit for a Claude Code environment: inventory it, lint it,
  surface idle context cost, and enrich prompts with the resources that actually exist.

## §0.2 Folder structure
```
claude-vault/
├── .claude-plugin/{plugin.json, marketplace.json}
├── agents/{vault-auditor.md, prompt-enricher.md}
├── commands/{vault-refresh.md, vault-doctor.md, enrich.md, vault-usage.md,
│            vault-prune.md, vault-list.md, vault-map.md}
├── scripts/{scan-claude-dir.mjs, check-references.mjs, crunch-usage.mjs,
│           apply-disable.mjs, build-map.mjs}
├── CONVENTIONS.md
└── README.md
```

## §0.3 Naming conventions
- Commands are `/vault-*` (governance verbs) except the flagship `/enrich`, the one
  user-facing headline command without the prefix.
- A subagent's frontmatter `name` MUST equal its file name.
- Vault files: `.claude/vault.json` is CANONICAL; `.claude/vault.md` is a rendered view.

## §0.4 Coexistence with your existing `.claude/` resources
`claude-vault` adds its own `vault-auditor` / `prompt-enricher` subagents and `/vault-*`
+ `/enrich` commands. If your environment already defines a resource with one of those
names, Claude Code namespaces the plugin copy (`claude-vault:vault-auditor`) so both can
coexist; the inventory records each origin separately (`scopeOf`: `plugin` vs `user`) and
never collapses them. The plugin only ever reads your other resources — it adds nothing
to and removes nothing from them except through an explicit, confirmed `/vault-prune`.

## §0.5 Canonical paths + bootstrap contract
- Scope: active project `.claude/` first, then global `~/.claude/`. A command resolves
  project-first, then global (or global if the user asked).
- Existence/staleness is judged on `vault.json` via its `generatedAt` field.
- A command that needs the vault:
  - `vault.json` MISSING → offer to run `/vault-refresh` (ONE confirmation), then proceed.
  - `vault.json` STALE (`generatedAt` > 30 days) → warn once, proceed anyway.
  - Never run a full audit silently.

## §0.6 vault.json schema (the data contract)
```jsonc
{
  "generatedAt": "<ISO8601>",
  "scope": "project | global",
  "root": "<absolute path scanned>",
  "resources": [{
    "name": "string",
    "category": "agent|skill|command|hook|mcp|plugin|rule|project",
    "invocation": "model|user|event",          // event = hooks
    "contextCostClass": "HIGH|MED|LOW|ZERO",    // §0.7
    "source": "<relative path or settings key>",
    "scopeOf": "user|plugin|project",           // for shadow detection
    "status": "active|disabled|inferred",
    "disableMechanism": "<exact lever>",        // §0.8
    "triggerOrDescription": "<string>"
  }]
}
```
`vault.md` is always rendered FROM `vault.json` in the same run, so the two never drift.

## §0.7 contextCostClass rules
- HIGH : mcp servers; plugin skills; hooks on UserPromptSubmit / SessionStart / PreToolUse.
- MED  : user model-invoked skills; user agents that carry a description.
- LOW / ZERO : user-invoked commands; skills with `disable-model-invocation:true`;
  anything already inside a `*-disabled/` folder.

## §0.8 disableMechanism by category
- plugin (whole)        : set `enabledPlugins["name@marketplace"]=false` (settings.json)
- plugin skill (single) : NOT INDIVIDUALLY DISABLEABLE — group under its plugin
- user skill            : `disable-model-invocation:true` OR move to `skills-disabled/`
- user agent            : move to `agents-disabled/`
- user command          : move to `commands-disabled/`
- hook                  : remove/comment the entry in settings.json or hooks/hooks.json
- mcp server            : guided via `/mcp` + config edit (no reliable per-server toggle)

## §0.9 Severity taxonomy
🔴 BROKEN (silent failure) · 🟡 RISKY (works but degrades) · 🟢 HYGIENE · ⚪ INFO.
Reports order findings highest-severity first, with a per-tier count header.

## §0.10 Cross-cutting rules
- All artifact content in English; preserve the user's own language in their request.
- Read-only by default. Any mutation requires a per-action confirmation.
- Never read or emit secrets (`.credentials.json`, tokens, env values).
- Ignore runtime dirs when scanning: `cache/`, `daemon/`, `debug/`, `file-history/`,
  `metrics/`, `session-data/`, `session-env/`, `sessions/`, `shell-snapshots/`,
  `telemetry/`, `backups/`, `ide/`, `downloads/`, `*.log`, `history.jsonl`,
  `*-cache.json`, `.last-cleanup`, `.credentials.json`.
- `${CLAUDE_PLUGIN_ROOT}` resolves the plugin's install root (used to locate `scripts/`).

# Claude Vault

A per-user governance kit for your Claude Code environment. Claude Vault
audits what lives in your `.claude/` directory, lints it for conflicts and dead
configuration, surfaces idle context cost, and helps you keep the environment
clean and intentional.

The thesis is **inventory → use well → prune**, and the full pipeline ships:
a deterministic inventory engine, prompt enrichment, a read-only
health check, behavioral usage analysis, safe reversible pruning, and two ways
to view the inventory (markdown list + offline HTML map).

## What's shipped

| Component | Type | What it does |
|-----------|------|--------------|
| `vault-auditor` | subagent | Scans `.claude/` and writes `vault.json` (canonical inventory) + `vault.md` (rendered view). Inventory only — no log analysis, no mutation. |
| `/vault-refresh` | command | Thin orchestrator that runs `vault-auditor` and reports per-category counts. |
| `/vault-doctor` | command | Read-only structural health check: trigger collisions, shadowing, broken references, name mismatches, weak descriptions, hygiene, and honest limits — grouped by severity. Offers safe fixes; never auto-applies. |
| `prompt-enricher` | subagent | Composes the enriched-prompt draft for `/enrich`: preserves the user's intent while adding structure, relevant vault resources, and an effort recommendation. Read-only; never executes. |
| `/enrich` | command | Flagship. Turns a raw request into a sharper, resource-aware prompt, shows the draft + a change-log, and runs it only after approval. Transparent (draft → approve → act), never covert. |
| `/vault-usage` | command | Behavioral layer. Crunches local logs, joins usage to the vault by name, and ranks idle resources weighted by context cost (recency × cost). Writes `usage.json`; honest about undocumented log limits. Disables nothing. |
| `/vault-prune` | command | Capstone. Consumes `vault.json` + `usage.json`, proposes the exact reversible disable per resource (§0.8), and applies it only on a per-item confirmation. Never deletes, never batches; backs up settings edits and logs every change to `prune-log.json` for undo. |
| `/vault-list` | command | Read-only queryable view of `vault.json` as filtered, sorted markdown tables (by category, cost, status, scope). Adds a Last-used column when `usage.json` exists. |
| `/vault-map` | command | Generates a self-contained `vault-map.html`: resources sized by context cost, colored by status, tinted by idle severity when usage data exists, hooks laid out by lifecycle event. Renders offline. |

Six Node helper scripts do the deterministic, token-cheap heavy lifting:
`scan-claude-dir.mjs` (enumeration), `check-references.mjs` (reference resolution),
`crunch-usage.mjs` (log aggregation), `join-usage.mjs` (usage-to-vault join + idle
severity), `apply-disable.mjs` (reversible disable executor), and `build-map.mjs`
(self-contained HTML generation). They are cross-platform
(Windows + POSIX) and require Node only (no Python).

## Requirements

- Claude Code with plugin support.
- Node.js available on `PATH` (the helper scripts are plain ESM `.mjs`).

## Install

Add the marketplace, then install the plugin:

```
/plugin marketplace add vitoledo/claude-vault
/plugin install claude-vault
```

## Usage

Build or rebuild the inventory:

```
/vault-refresh
```

This writes `vault.json` (canonical) and `vault.md` (rendered view) to the active
project's `.claude/`. Ask for a global vault if you want `~/.claude/` instead.

Run a health check:

```
/vault-doctor
```

This reads `vault.json` plus the filesystem and prints a severity-ordered report.
If no inventory exists yet, it offers to run `/vault-refresh` first. It never
changes your files without a per-fix confirmation.

Enrich a request before running it:

```
/enrich help me design a multi-tenant billing service
```

This rewrites your request into a structured, resource-aware prompt, shows you the
draft and a change-log of exactly what was added (structure, vault resources, an
effort recommendation), and runs it only after you approve, like plan mode. Your intent and wording
are preserved — enrichment amplifies, it never reinterprets.

## Scope and safety

- **Scope resolution:** project `.claude/` first, then global `~/.claude/`.
- **Read-only by default:** audits and lints never mutate. Any change requires a
  per-action confirmation.
- **Secrets are never read or emitted** (`.credentials.json`, tokens, env values).
- **Runtime directories are ignored** (caches, sessions, logs, telemetry, etc.).

## Data contract

`vault.json` is the canonical inventory every component parses. Each resource
carries: `name`, `category`, `invocation`, `contextCostClass`, `source`, `scopeOf`,
`status`, `disableMechanism`, and `triggerOrDescription`. `vault.md` is always
rendered from `vault.json` in the same run, so the two never drift.

The full schema, cost classes, disable mechanisms, severity taxonomy, and bootstrap
contract live in [CONVENTIONS.md](./CONVENTIONS.md). The component bodies cite those
rules by section number (e.g. "§0.5"), which resolve to that file.

## Roadmap

The full roadmap is shipped: inventory (`/vault-refresh`), use-well (`/enrich`),
correctness (`/vault-doctor`), behavior (`/vault-usage`), pruning (`/vault-prune`),
and presentation (`/vault-list`, `/vault-map`).

## License

[MIT](./LICENSE) © Victor de Toledo

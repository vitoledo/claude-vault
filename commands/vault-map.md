---
description: Generate a self-contained HTML visualization of your environment — resources sized by context cost, colored by status, tinted by idle severity when usage data exists, with hooks laid out by lifecycle event. Read-only beyond writing vault-map.html; renders offline.
---

<role>
You are /vault-map — the visual sibling of /vault-list, and the ONLY component in
claude-vault that emits HTML. You bootstrap, run the deterministic map generator
against vault.json (§0.6) and usage.json (§U, if present), and report the written
path. You produce a single self-contained `vault-map.html` that renders offline; you
do not template the HTML yourself (that is the script's deterministic job) and you
mutate nothing else.

Section references below (§0.x) resolve to CONVENTIONS.md in this plugin.
</role>

<core_principles>
1. READ-ONLY BEYOND THE ARTIFACT. The only thing you write is vault-map.html. No
   resource mutation, no log reading.
2. SELF-CONTAINED OUTPUT. The generated HTML inlines all CSS/JS, references no
   external/CDN resources, makes no network calls, and renders offline from file://.
3. HONEST ENCODING. The legend explains the cost/status/usage encoding and states
   plainly that usage is a best-effort signal (§U honesty mandate). Usage tint appears
   only when usage.json is present.
4. DETERMINISTIC. Same inputs → identical HTML (the script enforces stable ordering).
</core_principles>

<workflow>
STAGE 0 — Bootstrap (§0.5).
- Resolve scope: project `.claude/` first, then global.
- vault.json MISSING → offer to run /vault-refresh (one confirm), then proceed.
- vault.json STALE (> 30 days) → warn once, proceed.

STAGE 1 — Generate.
- Run the bundled generator:
    node "${CLAUDE_PLUGIN_ROOT}/scripts/build-map.mjs" --root <resolved .claude path>
- It reads vault.json and, if present, usage.json, and writes
  <scope>/vault-map.html. If usage.json is absent, the map shows cost + status only
  and the legend says so; if present, an idle-severity tint is added.

STAGE 2 — Report.
- Report the written path and offer to open it. The file is self-contained and opens
  directly in a browser, offline.
</workflow>

<rules>
- The ONLY HTML emitter in the suite. Markdown siblings (/vault-list) stay markdown.
- Read-only beyond writing vault-map.html. No resource mutation, no log reading.
- The generated HTML must be self-contained: no external/CDN refs, no network calls,
  renders offline. (The script enforces this; do not hand-edit in external resources.)
- Usage tint only when usage.json exists; legend honest about the best-effort signal.
- Never embed secrets or raw file contents — only vault.json / usage.json fields.
- ${CLAUDE_PLUGIN_ROOT} locates scripts/.
</rules>

<output_format>
A short report:
"Wrote vault-map.html → .claude/vault-map.html (with usage tint | cost+status only).
 Open it in a browser — it's self-contained and works offline."
</output_format>

<self_check>
1. Did I bootstrap §0.5 and run build-map.mjs against vault.json (+usage.json if present)?
2. Is exactly one self-contained vault-map.html written (no external resources)?
3. Does the map encode area ∝ cost, color = status, and a usage tint ONLY when
   usage.json exists, with an honest legend?
4. Did I read no logs and mutate nothing beyond the .html, embedding no secrets?
</self_check>

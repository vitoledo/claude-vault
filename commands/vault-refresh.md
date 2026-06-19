---
description: Rebuild the environment inventory. Invokes vault-auditor to scan .claude/ and (re)write vault.json + vault.md, then reports per-category counts.
---

<role>
You are the /vault-refresh command — a THIN orchestrator. Your only job is to
invoke the vault-auditor subagent and relay its one-line result. You do not scan,
classify, or render yourself; vault-auditor owns all of that.
</role>

<workflow>
1. Resolve scope per Bootstrap §0.5: default to the active project `.claude/`;
   use `~/.claude/` only if the user asked for a global vault. Project-first, then
   global.
2. Delegate to the vault-auditor subagent for the resolved scope. Let it run its
   full 6-stage inventory and write vault.json (canonical) + vault.md (rendered).
3. On completion, report in ONE line the per-category counts and the path written.
   Do not duplicate the auditor's work or re-summarize its internals.
</workflow>

<rules>
- This command is an orchestrator, not a scanner. All inventory logic lives in
  vault-auditor.
- Bootstrap behavior follows §0.5. A refresh always overwrites vault.json; no
  confirmation is needed to refresh because writing the inventory is the command's
  declared purpose (the read-only/confirmation rules apply to MUTATING the user's
  resources, which this does not do).
- Never read or emit secrets.
</rules>

<output_format>
A single line, e.g.:
"vault.json rebuilt (agents: 4, commands: 6, skills: 3, rules: 2, projects: 1, hooks: 1, mcp: 2, plugins: 1) -> .claude/vault.json"
</output_format>

<self_check>
1. Did I delegate to vault-auditor rather than scanning myself?
2. Did I resolve scope per §0.5?
3. Is my output exactly one summary line?
</self_check>

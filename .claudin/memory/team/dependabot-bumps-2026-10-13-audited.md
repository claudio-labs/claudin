---
name: dependabot-bumps-2026-10-13-audited
description: Dependabot #296 (shell-quote 1.12, anthropic sdk 0.133, mcp 1.32.1, marked 18.1, execa 10.1, p-map 7.1, firecrawl 4.46, google-auth 11.2, smol-toml 1.9.1) audited 10-13 — shell-quote 1.12's new ops left extractOutputRedirections blind to &> >| <> targets (decisions unchanged); capture restored in fix/shell-quote-1.12-redirect-ops
type: project
---

#296 (12 production deps) landed on main 2026-10-13 (`1a077be5`), next to #295
(dev batch, see [[dependabot-bumps-2026-10-06-audited]]). Audited the same day by
diffing the old and new trees in `~/.bun/install/cache/<pkg>@<ver>@@@1/`. No
code change was required.

- **shell-quote 1.11 → 1.12 — the one to watch.** `parse()` now emits `&>`,
  `&>>`, `>|`, `<>`, `>(`, `<<`, `<<-`, `;&`, `;;&` as ONE op (before: `&`+`>`,
  `>`+`|`, `<`+`<`…). `handleRedirection` in `src/platform/bash/commands.ts`
  knows only `>`, `>>`, `>&`, so `extractOutputRedirections` no longer captures
  the target of `&>`, `&>>`, `>|`, `2>|`, `<>` — and its `>`-then-`|` branches
  (the `>|`/`2>|` handling) are dead code now. **Final decisions did not move:**
  the unknown op makes `isCommandList` false, the op stays a subcommand that no
  rule matches, so it asks — exactly as `&>` did on 1.11, where it parsed as
  background `&`. Evidence: 42,542 Bash commands from the session corpus, 3,057
  with different token streams (`<<` 3487, `>(` 149, `>|` 4, `<>` 3, `&>` 1), run
  through `bashToolHasPermission` in 4 contexts (default, allow rules,
  acceptEdits, allow+deny `Edit(//etc/**)`) plus read-only, toolRedirect and
  isSilentBashCommand on both versions: 0 decision changes. The invariant in
  `hasDangerousExpansion`'s doc comment ("every target is captured or flagged")
  was broken for those ops. **Restored** on branch
  `fix/shell-quote-1.12-redirect-ops`: `SINGLE_TOKEN_OUTPUT_REDIRECTIONS` in
  `commands.ts` (`2>|` keeps its fd, any non-plain target fails closed), probes
  in `scripts/migrations/probes/shellQuoteRedirectOps.json`. Its capture matches
  main+1.11 on all 3,393 corpus+synthetic rows, with 0 decision changes in 6
  contexts (sandbox auto-allow included). A deny rule still does not reach
  `&> /etc/x` — the compound check asks first, on 1.11 too. Do NOT add the ops
  to `ALL_SUPPORTED_CONTROL_OPERATORS` without re-running the corpus — that
  would relax acceptEdits for in-cwd `&>`.
- **MCP SDK 1.32:** HTTP/SSE transports and OAuth fetches get
  `redirectPolicy: 'same-origin'` by default — an MCP URL that redirects to
  another origin now fails with "Redirect … not followed". Kept the default;
  `redirectPolicy: 'follow'` in `src/mcp/client/transport.ts` restores it.
  `OAuthClientProvider` unchanged, issuer logic unchanged.
- **sdk 0.133:** new unused `internal/data/deprecated-models` lists
  `claude-mythos-preview` — a later SDK will likely warn on it. The live warn
  list is still only sonnet-4-5 (Foundry default retires 2026-11-30).
- No action: bedrock/vertex/foundry (client.mjs identical), marked (same token
  types; unbalanced-paren link defs now render as text), execa, p-map, smol-toml,
  google-auth (build/ byte-identical), firecrawl.

**Recipe — replay a dep bump over the corpus:** a scratch `*.test.ts` that does
`mock.module('shell-quote', () => require('<cache>/shell-quote@OLD@@@1/index.js'))`
under an env flag and imports `src/` by absolute path, run once per arm, diff the
JSONL. Placeholders (`__NEW_LINE_<salt>__`, `__HEREDOC_0_<salt>__`) leak into
`splitCommand_DEPRECATED` output for some commands on BOTH versions — pre-existing,
and the salt makes those rows differ run to run; ignore them in the diff.

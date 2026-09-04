---
paths:
  - "src/agent/cache/**"
  - "src/providers/shims/claude/**"
  - "src/agent/tools/toolResultCache.ts"
  - "src/agent/tools/cacheInvalidation.ts"
---
# Prompt Cache & Tool-Result Cache — Claudin Development Rules

Architecture: `src/agent/cache/README.md` + `docs/tech/cache/clip-frontier-breakpoint.md`.
This rule captures the **invariants** that are easy to break silently — verify
file:line against current code.

## 1. The cross-cutting invariant (never break this)

Any new marker, stub, injection, or attachment MUST sit **behind the clip
frontier** and must not mutate bytes behind the message-level `cache_control`
marker. Formally: **turn N's full render must be a byte-identical prefix of turn
N+1's** (with `cache_control` stripped). A single mutated byte behind the marker
invalidates the whole prefix and silently rebills `cache_creation`.

- Regression guard: `requestDeterminism.invariant.test.ts` (break-and-restore).
- When adding anything to the request, ask "does this change a byte before the
  marker on a later turn?" If yes, it belongs after the frontier or not at all.

## 2. Defer-cache-marker — `Math.max(i, 0)` fallback is load-bearing

`src/providers/shims/claude/paramBuilders.ts::addCacheBreakpoints` does NOT pin the
single `cache_control` marker at `messages[length-1]` each turn — it walks
backward summing `roughTokenCountEstimationForMessage` and places the marker at
the earliest index whose suffix sums to ≥ `DEFAULT_DEFER_CACHE_MARKER_TOKENS`
(2048). Runtime override: `CLAUDIN_DEFER_CACHE_MARKER=<N>` (0 = baseline).

- **Why:** Anthropic's cache silently discards writes when the trailing block
  between markers is too small (~1024 tok). A per-turn last-message marker makes
  every small tool-loop turn fall below the floor → billed but not stored.
- **DO NOT "simplify" the `Math.max(i, 0)` head-anchor fallback.** Pinning to
  `messages[0]` when the loop exhausts is intentional; an "elegant" fallback to
  `baseMarkerIndex` (length-1) regressed the bench from r:w 10.48 → 0.78. The long
  comment in `paramBuilders.ts` documents this — respect it.
- `skipCacheWrite` bypasses the defer logic (preserved). Tests memoize the
  threshold: call `_resetDeferCacheMarkerForTesting()` after flipping the env
  (`src/providers/shims/claude/__tests__/addCacheBreakpoints.test.ts`).

## 3. toolResultCache keys omit cwd — invalidate on any chdir

`src/agent/tools/toolResultCache.ts` keys entries as
`tool::stableStringify(input)` — **no cwd component**. A relative-path arg maps to
the same key before and after `process.chdir()`, serving a stale hit against the
wrong directory. The Read mtime guard is NOT a backstop; Glob/Grep/LSP have none.

- Any mid-session `process.chdir()` MUST call `invalidateAll()` after the chdir.
  Existing homes: worktree enter/exit (`cacheInvalidation.ts`), `WorktreeExitDialog`
  (`recordWorktreeExit()`), `/resume` slash command (`sessionRestore.ts`).
- **The `/resume` slash command is NOT a session boundary** — it reuses the warm
  process, so it must invalidate. EXEMPT only: true boundaries where the cache is
  still empty (`setup.ts` startup, the `--resume`/`--continue` CLI flag in
  `resume.ts`). Encoding cwd into the key was deliberately NOT done (broad
  semantic change).
- **`bypassResultCache` is per-context; the key is process-global.** A tool may
  opt a single call out of the cache before the lookup (`Tool.ts`
  `wrapCallWithCache`) — Read uses it so a clip/clear stand-down stays reachable,
  since a hit short-circuits `call()` for the whole TTL and `noResultCache` can
  only suppress the store of the call that produced it, never an entry an
  EARLIER call left behind. Consequence to keep in mind: two contexts (main
  thread vs sub-agent) can disagree about the same entry, and a bypass steps
  around the entry rather than deleting it, so it goes live again the moment the
  predicate stops firing. Anything that must not survive the TTL needs
  `invalidateForPath`, not a bypass.
- **A cache HIT skips `call()`, and with it every side effect `call()` has.**
  This is not only about the bytes returned: `readDispatch.ts` writes the
  `readFileState` entry *inside* `call()`, so a replayed Read handed the model
  the full body while the read-before-edit gate still said "has not been read
  yet" — measured five times in one session, each cleared only by a second
  identical Read (a REFUSED write does not invalidate, `toolExecution.ts` runs
  `invalidateCacheForWrite` after a successful call; any Bash `invalidateAll`s).
  The window is ordinary: `readFileState` holds 100 paths, the result cache 500
  for 60 s, and the session touched 219. `bypassResultCache` cannot cover it —
  the entry it would key on is exactly the one that went missing, which is
  indistinguishable from a first read. **How to apply:** a cacheable tool whose
  `call()` writes per-context state must implement `onCacheHit`
  (`Tool.ts` → `wrapCallWithCache`) to re-seed that state on replay. Read's
  seeds only when the context has NO entry: a partial view, an outline or a
  sticky stand-down marker is state `call()` owns, and a replayed body must not
  promote it.
  - The predicate itself must answer "is something in flight", never "did this
    ever happen". Read's asks `isPinShielding`, NOT `isPinRegistered`: the wide
    one also answers true for a *spent* id, and ids stay spent while their
    message lives, so keying on it made the path skip the cache permanently
    after one stand-down cycle. A bypass predicate that can latch is a cache
    that quietly turns itself off.
- **A pinned tool_result stalls the clip frontier by design.** `pinShieldsBlock`
  exempts a block from the clip paths, but `isToolResultBlockMutable` still
  counts it as mutable, so the `cache_control` marker cannot advance past it.
  Under `retain` this costs nothing (`agePruneActive` is false and the check
  short-circuits); under `aggressive` nothing past the static head is cached
  anyway. Do NOT "optimise" by making a pinned block immutable — the marker
  would then sit in front of bytes the clip paths are still entitled to rewrite
  the moment the pin expires.
- **The Read stand-down must hold TWO properties at once; every version so far
  has traded one for the other.** (1) No unbounded run of futile full bodies.
  (2) No indefinite refusal for a file readable on disk. The pin cannot deliver
  both alone: it is temporary by construction (`MAX_SHIELDED_PASSES`, the FIFO
  cap, the 8k ceiling) and `retirePinAfterUse` releases it after a single dedup
  hit, while the file is permanent — so pin-plus-re-arm oscillates at two full
  bodies every three reads when the pin cannot protect a round, four when it
  can. A permanently sticky marker fixed (1) and broke (2) harder than the
  version before it. Rules for touching it:
  - `standDownOutline` must stay ON the readFileState entry, never in a
    side-map keyed by path. Living on the entry is what makes a range switch
    and an LRU eviction clear it for free — the side-map was the actual defect
    of the old re-read breaker.
  - It must stay `isPartialView: true` and carry NO `toolUseId`. The first
    keeps the edit tools demanding a real Read (the model has seen an outline,
    not the body) and keeps the entry out of the dedup gate; the second makes
    the blind-pointer stub unrepresentable from this state.
  - **`STICKY_REPLAY_BUDGET` is load-bearing, not belt-and-braces.** Do not
    "simplify" it away. The other exits cannot cover property (2) on their own:
    Edit/Write look like an exit but are REFUSED while the marker stands, so
    they can never be what replaces the entry; and the epoch exit does not fire
    in the regime that creates the marker, because microCompact's whole job is
    to keep the session below the autocompact threshold. Without the budget the
    model can neither read its way to a body nor edit.
  - A registered clip id is NOT evidence of a clip while the pin is shielding.
    microCompact adds candidates without consulting the pin registry and
    `stubOneBlock` then skips the pinned ones, so `getClippedIds()` over-reports;
    `clientClippingDetection` must AND it with `isPinShielding`.
  - **Read-before-edit is a four-tool invariant.** `FileEditTool`,
    `FileWriteTool`, `applyPatch` and `NotebookEditTool` must all reject
    `!entry || entry.isPartialView`, and `file-pipeline.ts`'s already-read
    optimization must require `!isPartialView` too. NotebookEdit and the
    attachment path each checked only presence, which the sticky marker turned
    into a blind-notebook-edit path and a suppressed `@`-mention.
    One exception, and it is line-scoped only (2026-09-04): an entry the
    harness seeded for an auto-injected CLAUDE.md/rule/MEMORY.md carries
    `injectedView`, the stripped or truncated text the model was actually
    shown, and `satisfiesLineScopedReadGate` lets Edit and an `apply_patch`
    Update through on it — the coverage lane then checks the needle against
    `injectedView` instead of `content`. Write, NotebookEdit and `Delete File`
    stay on `satisfiesReadGate`: written back from a truncated view, the
    file would lose its tail. 8 of 65 gate refusals in the 2026-08/09 corpus
    were Edits of an injected file answered by a `view='full'` re-read of
    MEMORY.md. A clip-pin marker never carries `injectedView`, and the
    line-scoped gate refuses `standDownOutline` explicitly.
  - **Presence is not coverage** (2026-08-12). The gate answers "has the model
    seen this file", never "has it seen the lines it is changing": a range Read
    and a `symbol=` Read both write an entry with NO `isPartialView`
    (`FileReadTool.ts:2268`, `:1886`), so eight lines of a 2,200-line file used
    to authorize a patch anywhere in it — measured, in session `9825fb93`, as
    three token-sized re-Reads that lifted a refusal and changed nothing else.
    The second lane in `shared/readBeforeEditMessages.ts` closes it:
    `seenRegionCovers` requires a line-scoped write (an `apply_patch` Update
    chunk's `oldLines`) to sit inside the bytes the entry carries,
    `seenRegionCoversText` asks the same of Edit's `old_string`, and
    `needsWholeFileRead` requires a whole-file entry for a write that replaces
    the file (`Delete File`, `FileWriteTool`). Matching is per-line trimmed
    and — for hunks — line-anchored; Edit's predicate keeps only the INNER
    line anchors, because an `old_string` may start and end mid-line and the
    outer sentinels refused text the model was holding (6 refusals, one file
    twice, 2026-08/09). Never stricter than the callers' own fuzzy matchers,
    or it refuses writes that would have applied. Killswitch
    `CLAUDIN_DISABLE_READ_COVERAGE_GATE=1`. Do NOT "simplify" this into marking
    range reads `isPartialView`: a symbol read IS a range read, and
    `makeUnfoldData` (`FileReadTool.ts:1868-1873`) keeps those editable on
    purpose — that is the outline → symbol → edit flow the auto-outline pivot
    exists to enable. NotebookEdit stays out: it addresses cells, not lines.
  - **An entry stands for every read of that file VERSION, not just the last
    one** (2026-08-15). `set` used to replace the entry wholesale, so walking a
    file in slices accumulated no coverage and a narrow Read landing on a full
    one destroyed what the full one proved. Over 683 sessions that was 30 of 40
    `coverage:unseen-region` refusals — hunks whose old side sat verbatim in
    lines the model had already been shown — plus 561 whole-file entries
    clobbered by a later narrower Read. `carrySeenRanges`
    (`shared/fs/fileStateCache.ts`) now carries the previous slice forward and
    `coveredSegments` merges them **by line number**, so two slices join only
    where they touch. Three things hold it together, and all three have tests:
    the list is dropped the moment `timestamp` moves (bytes from an older
    version must never authorize a write); a gap between slices stays a gap (a
    concatenation would invent adjacency and pass a hunk spanning it); and the
    LRU's `sizeCalculation` counts the carried bytes, capped at
    `SEEN_RANGES_MAX_BYTES` (64 KB) — a cap at the per-read ceiling would evict
    by SIZE and trade a coverage refusal for a `never-read` one. The
    accumulation is not per-turn: it lives exactly as long as its entry, and
    compaction clears the whole cache anyway.
  - The obligation above belongs to consumers that read presence as **"the
    model has seen these bytes"** — not to every `readFileState` caller.
    `attachments/memory.ts:94,258,469` gate on `has()` and look like the same
    bug, but are not: that module WRITES `isPartialView` itself (`:110`) to
    mean "I injected a deliberately stripped form", so re-injecting on partial
    would re-inject every turn, forever. Check what presence is being used to
    *conclude* before copying the fix.
  - **The changed-files watcher WRITES to this cache, and used to corrupt it.**
    `getChangedFiles` skips entries with an `offset`, which is often described
    as "every Read-authored entry has one" — false: an outline entry writes
    `offset: undefined` (`outlineView.ts`), so outline entries are walked. What
    it does with them is the part that mattered: it re-read the file through
    FileReadTool with **no `view`**, i.e. as a vanilla Read, which for a code
    file over ~10 KB pivots to an outline and writes `isPartialView: true`. A
    file the model had read in FULL was silently downgraded, its next write
    refused with "only been seen as an outline", and — because an `outline`
    result matches neither the `text` nor the `image` arm — the change
    notification was dropped, so the model was never told the file had moved.
    38 of the 50 partial-view refusals on an already-read path had an
    out-of-band rewrite in between. It now lives in `attachments/changedFile.ts`
    (`services.ts` cannot be imported under `bun test`), reads with
    `view: 'full'`, normalizes the entry it writes back to the whole-file shape
    so the file stays eligible next turn, and evicts on ENOENT or over-cap
    rather than leaving a stale entry to retry every turn. **How to apply:**
    anything that re-reads a file on the model's behalf must pass `view:
    'full'` — a vanilla Read there is a cache write, not a read.

## 4. Cache TTL tiers — new query sources default to the expensive 1h

`should1hCacheTTL`/`cacheControl.ts`:
- `agent:*` → 5m (1.25x write) EXCEPT `agent:builtin:fork` (shares the main
  thread's 1h prefix); `SHORT_LIVED_QUERY_SOURCES` (web_search_tool,
  agent_summary, away_summary, hook_prompt, …) → 5m.
- Main-thread / compact / session_memory / speculation / auto_mode → keep 1h
  (they fork the main thread's prefix). `auto_mode` was tried at 5m and REVERTED
  (its classifier caches a session-growing, per-tool-call prefix — a mini main
  thread; >5min pauses would force full rewrites).
- **How to apply:** a new one-shot utility querySource must be added to
  `SHORT_LIVED_QUERY_SOURCES` or it silently pays the 1h tier; anything that
  re-sends the main thread's prefix must NOT be added.
- Slim-subagent: `omitClaudeMdAttachments`/`omitGitStatusAttachments` on
  ToolUseContext gate `claude_md_delta`/`nested_memory`/`git_status_delta` in
  `pipeline.ts`. New attachment producers read globals and
  bypass the gate — honor the flags explicitly or Plan/WebResearcher get
  full CLAUDE.md + rules re-injected per Read.

## 5. The `tools` array is part of the prefix — deferred tools included

`streaming.ts` sends **every** deferred tool on every request with
`defer_loading: true`. Do not reintroduce a "send only the discovered deferred
tools" filter: adding a deferred tool to the array after a ToolSearch was
measured to grow the cached system+tools block (+93 tokens for two tools) and
rewrite the entire history (50–134k tokens per discovery in real sessions).
The legacy filter lives behind `CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY=1`.
Regression probe: `scripts/bench/ab/tool-search-cache-probe.ts` (exit 1 if the
call after ToolSearch reads fewer cached tokens than the call before it).

- The break detector hashes deferred tools by `{name, defer_loading}` — never
  drop them from `toolsForCacheDetection` again; that is how this break hid as
  "likely server-side (prompt unchanged)" for weeks.
- A new tool whose result is disposable (read-only, re-runnable) sets
  `clearableResult: true` on the Tool; `clear_tool_inputs` is derived from the
  pool (`clearableToolNamesFromPool`). Don't add names to the fallback
  constant `TOOLS_CLEARABLE_RESULTS` — the flag is the source of truth.
- Anything that removes or rewrites messages behind the marker must call
  `notifyCacheDeletion(source, agentId, reason)` **with a reason** and
  `recordPrefixRewrite(reason)` (the relief clip in `microCompact.ts` does),
  so the rewrite shows on the `[Cache: …]` line instead of surfacing as a
  mystery dip.
- **Context relief is ONE decision, and it never drops a message.**
  `src/agent/compact/reliefPolicy.ts` (`decideRelief`, window + rss lanes)
  is the only thing that decides to clip; it runs pre-request from
  `microcompactMessages` on REAL usage (`tokenCountWithEstimation` over the
  stubbed view), and the only action is `addClippedIds`. Do not add a new
  post-turn pass that rewrites or evicts from the REPL's message array —
  that array seeds the next request, so every such pass was a prefix
  rewrite (`evictToMaxSize`, `evictOldStubbedMessages` and the post-turn
  byte-guard were deleted for exactly that; the display cap is a render
  slice in `REPL.tsx`). A new bound belongs as a lane in `decideRelief`, and
  a new clearable-result rule belongs in `collectClearableCandidates`.
  `docs/tech/cache/context-relief-policy.md` has the measurements and the
  cost model (`B* ≈ 60k`; tuning the band buys nothing, dropping content
  costs re-reads). `CLAUDIN_DISABLE_RELIEF_POLICY=1` turns off the window
  lane only.
- `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=1` silently turns off the retain
  profile's server-side `clear_tool_uses` (no `context-management` beta
  header → no `context_management` body). Check the env before attributing a
  context drop to the server; `docs/tech/cache/context-relief-policy.md` has the
  full map of the client mechanisms that fire instead.

## 6. Running cache perf experiments

- Prototype as a `CLAUDIN_*` env toggle → A/B with
  `scripts/bench/ab/cache-ab-bench.ts` → promote to default only on a measured win.
- **The bench is unreliable for head-to-head numbers**: `extractTimeline` rows are
  cumulative not delta, run-to-run variance is ~5×, and the `claude` binary exits
  1 under the harness. Cite the r:w direction/magnitude on the SAME harness run,
  never cross-tool absolute cost. Long-session-with-pauses is not exercised by the
  lockstep bench — revisit with a long-session bench before claiming parity.

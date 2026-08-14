# Read Outline (folded file views)

Claudin's `Read` tool can return a large code file as a **structural skeleton** — every function, class and object-literal member signature with its line range — and then expand a single symbol by name. Instead of choosing between "pay ~25k tokens for the whole file" and "guess `offset`/`limit` blindly", the model navigates big files the way a human does in an IDE: fold everything, open the one function that matters.

**On by default. No configuration required.**

## The problem

Coding agents read files through a size-capped tool. On a huge file (think a 2 000-line shim, a generated client, a god-module) the classic CLI has only two outcomes, and both are bad:

| Outcome | Cost | Problem |
|---|---|---|
| Throw `"file too large, use offset/limit"` | ~100 bytes | The model is left blind — it picks `offset`/`limit` with no idea where anything is, then slice-walks the file in expensive guesses |
| Truncate at the cap | ~25k tokens | Expensive, and the cut lands at an arbitrary line |

This trade-off is measured, not speculated: an upstream experiment (#21841, documented in `src/tools/FileReadTool/limits.ts`) tried truncating instead of throwing and **reverted it** — tool-error rate dropped but mean tokens rose. Neither branch of the dilemma wins; the missing option is one that is *both* cheap *and* informative.

There is a subtler failure below the cap, too: even a full read that *fits* (say 15k chars) induces a pathology — the model re-reads the same file in slices because a large literal body in a tool_result reliably triggers "I need to see the middle again" loops.

## What it does

Two optional `Read` parameters and one `Grep` mode, all over a single symbol-scan primitive:

| View | Call | Question it answers | Typical cost |
|---|---|---|---|
| **outline** | `Read(file, view='outline')` | "What's in this file?" | ~5–10% of the full-file tokens |
| **unfold** | `Read(file, symbol='login')` | "Show me this one function" | just that body, real line numbers |
| **search** | `Grep(pattern, output_mode='symbols')` | "Which functions mention X, across the repo?" | matched signatures only |

Precedence inside `Read` is `symbol` > `view` > `offset`/`limit`, honoured at any file size.

And three automatic behaviors, so the model benefits even when it never asks:

1. **Over-cap pivot** — a plain `Read` that blows the size caps (256 KB / 2 000 lines / ~25k estimated tokens) on a code file returns the **outline instead of an error**. The dead end becomes a map.
2. **Auto-outline on large reads** (`AUTO_OUTLINE_ON_ELISION`) — a vanilla full-file `Read` of a code file ≥ ~10 KB pivots to the outline with a footer explaining how to get more (`view='full'` forces the body, `symbol`/`offset` target a range). The ~10 KB floor is empirical: it is where the slice-walk re-read loop starts; returning the outline removes the stimulus entirely.
3. **Helpful misses** — `symbol='foo'` on a file that has no `foo` doesn't just fail: the error lists the available symbol names and points at `view='outline'`. On a name collision, the shallowest (top-level) entry wins.

## Why it matters on huge-file projects

The win compounds with file size and with session length:

- **Token cost**: reading one function from a ~2.3k-LoC file is ~2k tokens end-to-end (outline ≈ 1.5k + unfold ≈ 0.6k) vs ~26k for the full body. The bench is `scripts/profile/code-outline-bench.ts`.
- **No blind slicing**: the outline carries real line ranges, so the follow-up read is surgical — one `symbol` call, not a binary search with `offset`/`limit`.
- **Edits still work**: an unfold registers in `readFileState` as a partial read at the symbol's real `startLine`, so `Edit` freshness checks and line numbers behave exactly as after a normal partial read.
- **It feeds the cache policy**: outlines keep the retained history prefix ~45% smaller, which is part of why the lockstep cache bench landed 24% under Claude Code on the identical workload (see `docs/features/cache-policy.md`) — every cached re-read and every eviction re-write is cheaper when what was read was a skeleton.
- **Markdown too**: `.md` files outline by heading, so a 1 000-line design doc collapses to its table of contents.

## The advantages of never sending the whole file to the model

The deeper point is that a full-file read is **not a one-time cost** — and avoiding it pays out on every axis at once:

1. **A read is billed on every subsequent turn.** The agent's history is re-sent with each request, so a 25k-token file read on turn 3 of a 50-turn session is re-billed ~47 more times — as cached input at best (0.1×), as full-price input on providers without cached-read discounts. Reading a 1.5k-token skeleton instead saves not 23.5k tokens but 23.5k × the remaining turns. This compounding is why outline-reads show up so strongly in the end-to-end cache bench despite being a "read-time" feature.

2. **Context window is the scarcest resource, and full files exhaust it fastest.** Every full body occupies the window for the rest of the session. Skeletons let a session touch *far more files* before hitting the ceiling — which is exactly what huge-file projects (monorepos, generated clients, vendored code) need. It is also the first rung of the anti-autocompact ladder (see `docs/features/cache-policy.md`): what never enters the context never has to be stubbed, clipped, or summarized away later.

3. **Less noise means better answers, not just cheaper ones.** Model recall degrades as the context fills with irrelevant content — 2 000 lines of unrelated functions actively compete for attention with the task. An outline keeps the *map* (what exists, where) while excluding the *bodies* that don't matter, so the signal-to-noise ratio of the whole session stays high. The auto-pivot threshold exists for the same reason: large literal bodies in tool results demonstrably induce re-read loops; a skeleton doesn't.

4. **Targeted reads produce targeted edits.** When the model unfolds exactly the function it is changing — with its real line numbers — the edit context is precise. Dumping whole files invites edits anchored to the wrong copy of a similar-looking block.

5. **Smaller prompts are faster prompts.** Prompt-processing time scales with input size; on the lockstep bench Claudin ran ~2× faster per turn, with the smaller retained prefix as the main driver.

6. **And it stays safe**: the model is never *prevented* from seeing content — `view='full'`, `symbol` and `offset`/`limit` are always one call away, and the outline itself tells the model exactly what exists and where to look. The default just stops paying for bodies nobody asked for.

## How it works (design)

One primitive, no new tool, no new dependency:

```
src/tools/shared/codeOutline/
  scanSymbols.ts     scanSymbols(source, lang) → SymbolEntry[]
                     { name, kind, signature, startLine, endLine, depth, docLine? }
  renderOutline.ts   outline renderer (self-capped at 10k tokens so a
                     pathological file can't blow the cap with its own outline)
```

- **A depth-scanner, not an AST.** Strings, comments and regex literals are masked, then symbol bounds come from brace depth (C-like languages), indentation (Python), or heading level (Markdown). A symbol ends at the next sibling at the same depth or shallower. Both `outline` and `unfold` slice the *same* table, so their boundaries always agree.
- **Languages**: TypeScript/TSX, JavaScript/JSX, Python, Go, Java, Kotlin, C#, Rust, Markdown (by extension, `EXT_TO_LANG` in `scanSymbols.ts`).
- **Fails open.** Anything the scanner can't handle — unknown extension, file over the 10 MB scan cap, scan error — degrades to a normal `Read`. The feature can make a read cheaper; it can never block one.
- **Grafted into `Read`/`Grep` instead of a new tool**, deliberately: the model reaches for `Read` by instinct and hits the wall — inside `Read`, the wall becomes a map automatically, with no "know to switch tools" step. It also costs two optional schema params (~190 tokens) instead of a whole always-on tool schema (~400+, budget enforced by `scripts/measure-tool-schemas.test.ts`).

## How to activate / deactivate

The explicit `view`/`symbol` parameters and the over-cap pivot are always on. The auto-pivot on large (but under-cap) reads is build-time gated:

| Override | Effect |
|---|---|
| `CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION=1` | vanilla large reads return the full body again (over-cap pivot and explicit params unaffected) |
| `Read(file, view='full')` | per-call: force the full body of a file that would auto-pivot |

## Detailed docs

- `docs/features/7.1-smart-code-navigation.md` — original design doc (rationale, parser decision, rollout phases)
- `src/tools/shared/codeOutline/` — the scanner package. `scanSymbols.ts` is the barrel (dispatchers + public surface); `mask/` holds the string/comment masking, `clike/` the brace-depth engine and its per-language detectors, and `langs/` one module per non-C-like scanner
- `src/tools/FileReadTool/FileReadTool.ts` — `view`/`symbol` plumbing, over-cap pivot, `AUTO_OUTLINE_ON_ELISION` threshold rationale

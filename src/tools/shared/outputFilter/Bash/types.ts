import type { MatchOutputRule, ReplaceRule, RewriteContext } from "src/tools/shared/outputFilter/types.js";

export interface FilterSpec {
  name: string;
  matchCommand: RegExp;
  matchCommandReject?: RegExp;
  /** SECURITY INVARIANT: the returned command is EXECUTED in place of the one
   * the permission system approved. A rewrite must therefore only add
   * read-only output-formatting flags to the same verb (`--oneline`,
   * `--porcelain`, `--json <fields>`) — never change which program runs, touch
   * the filesystem/network semantics, or drop user-supplied arguments. This is
   * also why user filters (JSON) cannot define rewrites. */
  rewriteCommand?: (ctx: RewriteContext) => string | null | undefined;
  stripAnsi?: boolean;
  /** Whole-body renderer, for a reshaping no declarative stage can express.
   *
   * The line-oriented stages are stateless per line, so a transform that has to
   * see the whole body at once — parsing a unified diff into a stat table, say —
   * has nowhere to live among them. This is that seam.
   *
   * Return `null` to DECLINE, which is the normal outcome: a renderer that
   * cannot improve this particular body must say so rather than return it
   * unchanged, or the pipeline records a stage as applied and pays for a marker
   * that discloses nothing.
   *
   * It runs after `stripAnsi`/`matchOutput` and before `replace`, so it sees
   * text close to what the command printed. Being a function, it is not
   * expressible in the user-filter JSON — the same reason `rewriteCommand` is
   * not, and here too that is the point: the pipeline's other stages are data,
   * and arbitrary code from a config file is not something to eval. */
  renderBody?: (body: string) => string | null;
  replace?: ReplaceRule[];
  collapseRuns?: boolean;
  collapseDigitTemplates?: boolean | { minRun?: number };
  dedupGlobal?: boolean;
  matchOutput?: MatchOutputRule[];
  stripLinesMatching?: RegExp[];
  keepLinesMatching?: RegExp[];
  truncateLineAt?: number;
  headLines?: number;
  tailLines?: number;
  maxLines?: number;
  onEmpty?: string;
}

export interface PipelineResult {
  readonly body: string;
  readonly applied: readonly string[];
  readonly shortCircuited: boolean;
  readonly reductionPct: number;
  /** Line count of the raw input — surfaced in the marker as concrete evidence the filter ran. */
  readonly originalLines: number;
  /** Line count of the filtered body — `lines="bodyLines/originalLines"` tells the model what it would have gotten raw. */
  readonly bodyLines: number;
}

export interface PreExecPlan {
  readonly effectiveCommand: string;
  readonly filter: FilterSpec | null;
  readonly rewrite: { readonly from: string; readonly to: string } | null;
  /** Set when the rewrite was a trailing-reducer strip (`BASE | tail -N` → `BASE`).
   * The reducer is what the model asked for, so what it would have produced has to
   * be honoured after the fact: its exit status (`exitCodeAfterRewrite`) and its line
   * cap (the error path, where the filter pipeline that justified the strip does not
   * run). Absent for every other rewrite. */
  readonly droppedReducer?: DroppedReducer;
  /** True when the command that produced the output is compound (`a && b`, pipes, …).
   * The pipeline output then interleaves several commands, so `matchOutput`
   * short-circuits are unsafe — a "✓ up to date" sentinel from one segment would
   * silently swallow the other segments' output. Optional: absent means atomic. */
  readonly isCompound?: boolean;
  /** Set by a caller that budgets the result itself, so the filter must stop at
   * noise removal and leave every destructive stage alone.
   *
   * `GitTool` is the case this exists for: `runGitBatch` calls
   * `applyBashFilterToStdout` and then `budgetFilteredOutput`, which strips our
   * marker and applies its own diff/log budget — with a re-read delta lane
   * behind it that needs to see the same text every time. Letting the floor cap
   * the body first would make the delta lane diff against something it did not
   * produce, and would spend the cut twice.
   *
   * Called honestly, on the GitTool side this is DEFENSIVE rather than a fix for
   * a reachable bug: today the double render happens to be idempotent, because
   * the second `renderDiff` sees a stat table, finds no `diff --git` and no
   * `@@`, and declines. So no assertion on GitTool's output can tell the two
   * paths apart, and none pretends to. What it buys is that the property stops
   * depending on that coincidence — the next renderer added to a git spec does
   * not have to be idempotent for the delta lane to keep its baseline. The
   * mechanism itself IS pinned, on the filter side, in `bashFilter.test.ts`. */
  readonly callerBudgets?: boolean;
}

export interface DroppedReducer {
  /** The reducer verbatim, e.g. `tail -40` — quoted back to the model in the note. */
  readonly text: string;
  /** Lines it would have kept, or null when it caps nothing reproducible (`cat`, `tail -c`). */
  readonly lines: number | null;
}

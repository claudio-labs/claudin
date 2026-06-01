import type { MatchOutputRule, ReplaceRule, RewriteContext } from "../types.js";

export interface FilterSpec {
  name: string;
  matchCommand: RegExp;
  matchCommandReject?: RegExp;
  rewriteCommand?: (ctx: RewriteContext) => string | null | undefined;
  stripAnsi?: boolean;
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
}

/**
 * What the last summarization decided.
 *
 * Which strategy fired, whether an error window or a salient line survived and
 * how much was saved are decisions made deep inside `dispatch`, and the wrapped
 * string alone does not show them. They used to be observable only because they
 * were also shipped as an analytics event; that event reached a function the
 * build stubs to an empty body, so the tests were reading a channel that did
 * not exist outside the test process.
 *
 * This is that channel, made real and local. Overwritten on every call — it is
 * a last-write record for tests and for `--debug`, not a log.
 */
export type SummaryDecision = {
  toolName: string
  originalSizeBytes: number
  summarizedSizeBytes: number
  estimatedOriginalTokens: number
  estimatedSummarizedTokens: number
  strategyId: number
  /**
   * Absent — not `false` — for a strategy with no error-window concept (glob,
   * the AgentTool array path). The tests assert on that distinction.
   */
  errorWindowPreserved?: boolean
  /**
   * How many salient lines were pinned. `dispatch` reports a count, which the
   * old analytics payload flattened to a boolean — keep the count, it says
   * strictly more.
   */
  salientPinned?: number
  reductionPct: number
}

export type StrategyName =
  | 'head-tail-errors'
  | 'grep-grouped'
  | 'webfetch-stripped'
  | 'webfetch-head-tail'
  | 'glob-top-n'
  | 'agent-head-tail'
  | 'mcp-head-tail'
  | 'json-structural'
  | 'code-outline'

export type StrategyResult = {
  body: string
  strategy: StrategyName
  errorWindowPreserved?: boolean
  /**
   * grep-grouped only: how many match lines the body replaced with a counter
   * (`+N more matches`, `<omitted>`). Zero means every match rg reported is
   * still individually addressable in the summary. The dispatch gate reads it
   * rather than grepping the body, so a change to the counter wording cannot
   * silently turn a lossy summary into an eligible one.
   */
  matchesElided?: number
  /**
   * json-structural only: count of salient (error-keyword / rare-status) rows
   * pinned out of the dropped middle. Surfaced in analytics so the real-world
   * hit-rate of salient-row preservation can be measured (ROADMAP #6).
   */
  salientPinned?: number
  /**
   * Optional envelope-level metadata describing the elision. Placed as
   * attributes on the opening `<tool-result-summary>` tag so the model sees
   * structured key/value pairs rather than narratable prose.
   *
   * DESIGN: Elision is communicated via envelope attributes and self-closing
   * metadata tags (e.g. `<omitted lines="361"/>`) rather than inline prose
   * markers (e.g. "[…middle elided, lines 51-411 omitted…]"). Bench data on
   * Opus 4.8 (see scripts/bench/results/serial-read-nudge-ab-claude-opus-4-8-
   * 2026-05-30T16-53-58-546Z.md) showed ~80% of residual inter-tool-call
   * narration was elision-reaction commentary ("o miolo foi omitido, vou ler
   * em janelas menores", "the summarizer cut the two most important
   * sections"). Models commentate on prose; they rarely commentate on
   * attribute-style metadata. Same information, different shape.
   */
  envelopeAttrs?: Record<string, string>
}

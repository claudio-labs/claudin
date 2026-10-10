export type StrategyName = 'compact-grep' | 'compact-glob'

export type StrategyResult = {
  body: string
  strategy: StrategyName
  /**
   * Envelope-level metadata, placed as attributes on the opening
   * `<tool-result-compacted>` tag so the model sees structured key/value pairs
   * rather than narratable prose — models commentate on prose, rarely on
   * attribute-style metadata.
   */
  envelopeAttrs?: Record<string, string>
}

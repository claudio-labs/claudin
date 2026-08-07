// Reconstructed from its use sites — the original module was not carried into
// this fork. Every consumer of this module imports from it with `import type`
// only, so it holds no runtime helpers despite the `utils` name.

/**
 * What the user answered to the inline feedback survey.
 *
 * The values are the ones `FeedbackSurveyView`'s `inputToResponse` map produces
 * for the digits 0-3.
 */
export type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'

/**
 * Which survey is being shown — reported as `survey_type` in analytics and used
 * to key the "last shown" cooldown so the variants don't starve each other.
 */
export type FeedbackSurveyType =
  | 'session'
  | 'memory'
  | 'post-compact'
  | 'skill-improvement'

/**
 * Characters that change what a reviewer sees without changing what the
 * model reads. Bidi embedding, override and isolate controls reorder a line
 * on screen (Trojan Source, CVE-2021-42574); Unicode tag characters
 * (U+E0000–E007F) render as nothing at all while a model reads them as the
 * ASCII they shadow. Team memory reaches every teammate's context through a
 * commit, and the PR is its only review, so the team write guard refuses
 * both (teamMemSecretGuard.ts) and `claudin memory audit` fails on them.
 *
 * A zero-width joiner, LRM or RLM alone is ordinary text — emoji sequences,
 * Persian, right-to-left prose — and is not flagged; the secret scanner reads
 * past it instead (secretScanner.ts).
 */
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/u
const TAG_CHARACTER_RE = /[\u{E0000}-\u{E007F}]/u

/** What `content` hides, once each: `bidi control`, `Unicode tag characters`. */
export function findHiddenText(content: string): string[] {
  return [
    ...(BIDI_CONTROL_RE.test(content) ? ['bidi control'] : []),
    ...(TAG_CHARACTER_RE.test(content) ? ['Unicode tag characters'] : []),
  ]
}

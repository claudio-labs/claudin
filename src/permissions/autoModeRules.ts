/**
 * Pure helpers for the `autoMode` classifier rules a user can configure.
 *
 * Three jobs, all of them about not trusting the content of a rule array:
 *
 * 1. `$defaults` expansion — a user section REPLACES the shipped defaults unless
 *    it says otherwise. Including the literal entry `$defaults` splices the
 *    shipped rules back in at that position, which is how `/auto-mode-setup`
 *    writes a config that extends instead of overwriting.
 * 2. Sanitization — entries reach the classifier's system prompt verbatim, one
 *    `- ` bullet per entry. Anything that could forge a bullet, hide text from
 *    the reviewer, or impersonate the prompt's own delimiters is dropped.
 * 3. Broad-allow filtering — an allow entry that would hand the classifier a
 *    blanket "yes" defeats the classifier; those are dropped and reported.
 *
 * Consumed at read time (`getAutoModeConfig`), at prompt-build time
 * (`buildYoloSystemPrompt`) and at proposal time (`/auto-mode-setup`), so it
 * stays free of settings and provider imports.
 */

/** Literal entry that expands to the shipped defaults for that section. */
export const DEFAULTS_SENTINEL = '$defaults'

/** Entries kept per section; the rest are dropped. */
export const MAX_ENTRIES_PER_SECTION = 200

/** Characters kept per entry; longer entries are dropped whole. */
export const MAX_ENTRY_CHARS = 10_000

/** Total bytes past which a config is worth warning about. */
export const CONFIG_SIZE_WARN_BYTES = 50_000

export type AutoModeSectionName = 'allow' | 'soft_deny' | 'environment'

export type RuleDropReason =
  | 'empty'
  | 'control-characters'
  | 'invisible-characters'
  | 'settings-token'
  | 'too-long'
  | 'over-entry-cap'
  | 'too-broad'

export type DroppedRule = {
  entry: string
  reason: RuleDropReason
}

export type SanitizedRules = {
  entries: string[]
  dropped: DroppedRule[]
}

// C0/C1 controls including \t, \n and \r: an entry is rendered as a single
// `- ` bullet, so any line break forges a bullet the user never approved.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/

// Format characters (bidi overrides, zero-width joiners, tag characters),
// line/paragraph separators, and variation selectors — all of them can make the
// text a reviewer sees differ from the text the classifier reads.
const INVISIBLE_CHARS_RE =
  /[\p{Cf}\p{Zl}\p{Zp}\u2028\u2029\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/u

// The prompt wraps user content in <settings_…> style delimiters; an entry
// carrying one could close the section and speak as the prompt itself.
const SETTINGS_TOKEN_RE = /<\/?settings_/i

// Permission-rule shapes that match every invocation of a tool.
const WILDCARD_RULE_RE = /^[A-Za-z_][A-Za-z0-9_]*\((\*|:\*|\s*)\)$/

// Shell-shaped rules broad enough to cover arbitrary command execution.
const BROAD_SHELL_RULE_RE =
  /^(Bash|PowerShell)\(\s*(sh|bash|zsh|dash|ksh|fish|curl|wget|eval|python3?|node|perl|ruby|env|xargs|sudo|doas|pwsh|powershell)\b[^)]*\*[^)]*\)$/i

// Prose that grants everything. Kept deliberately short: this filter exists to
// catch a blanket "yes", not to police wording.
const BLANKET_PROSE_RE =
  /^(?:allow\s+)?(?:any|all|every)\s+(?:tool\s+calls?|tool\s+uses?|commands?|bash\s+commands?|shell\s+commands?|actions?|operations?)\b/i

/**
 * Drop entries that must never reach the classifier prompt, and cap the
 * section. Order is preserved; every drop is reported with its reason so the
 * caller can surface it instead of silently shrinking the user's config.
 */
export function sanitizeRuleEntries(entries: readonly string[]): SanitizedRules {
  const kept: string[] = []
  const dropped: DroppedRule[] = []

  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      dropped.push({ entry: String(entry ?? ''), reason: 'empty' })
      continue
    }
    if (entry.length > MAX_ENTRY_CHARS) {
      dropped.push({ entry, reason: 'too-long' })
      continue
    }
    if (CONTROL_CHARS_RE.test(entry)) {
      dropped.push({ entry, reason: 'control-characters' })
      continue
    }
    if (INVISIBLE_CHARS_RE.test(entry)) {
      dropped.push({ entry, reason: 'invisible-characters' })
      continue
    }
    if (SETTINGS_TOKEN_RE.test(entry)) {
      dropped.push({ entry, reason: 'settings-token' })
      continue
    }
    if (kept.length >= MAX_ENTRIES_PER_SECTION) {
      dropped.push({ entry, reason: 'over-entry-cap' })
      continue
    }
    kept.push(entry.trim())
  }

  return { entries: kept, dropped }
}

/** True when the section asks for the shipped defaults to be kept. */
export function hasDefaultsSentinel(entries: readonly string[]): boolean {
  return entries.some(entry => entry.trim() === DEFAULTS_SENTINEL)
}

/**
 * Resolve a user section against the shipped defaults.
 *
 * - no sentinel → the user entries replace the defaults (historical behavior,
 *   so an existing hand-written config keeps working unchanged)
 * - one sentinel → the defaults are spliced in at that position
 * - several sentinels (sections from different settings sources are
 *   concatenated) → only the first expands, the rest are dropped
 */
export function expandDefaults(
  userEntries: readonly string[],
  defaults: readonly string[],
): string[] {
  if (userEntries.length === 0) return [...defaults]

  const resolved: string[] = []
  let expanded = false
  for (const entry of userEntries) {
    if (entry.trim() === DEFAULTS_SENTINEL) {
      if (!expanded) {
        resolved.push(...defaults)
        expanded = true
      }
      continue
    }
    resolved.push(entry)
  }
  return resolved
}

/**
 * Drop allow entries that would hand the classifier a blanket approval. An
 * allow rule matching every Bash invocation makes auto mode a no-op, so these
 * are refused rather than honored.
 */
export function filterBroadAllowEntries(
  entries: readonly string[],
): SanitizedRules {
  const kept: string[] = []
  const dropped: DroppedRule[] = []

  for (const entry of entries) {
    const trimmed = entry.trim()
    if (
      WILDCARD_RULE_RE.test(trimmed) ||
      BROAD_SHELL_RULE_RE.test(trimmed) ||
      BLANKET_PROSE_RE.test(trimmed)
    ) {
      dropped.push({ entry, reason: 'too-broad' })
      continue
    }
    kept.push(entry)
  }

  return { entries: kept, dropped }
}

/**
 * Split a `<user_*_to_replace>` tag body into its bullet entries. Bullets are
 * single-line in the template, so one `- ` line is one entry.
 */
export function parseBulletBlock(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2))
}

/**
 * Render one section of the classifier prompt. With no user entries the
 * template's own block is returned untouched; otherwise the entries are
 * resolved against it (see `expandDefaults`) and re-rendered as bullets.
 */
export function renderRuleSection(
  entries: readonly string[],
  defaultsBlock: string,
): string {
  if (entries.length === 0) return defaultsBlock
  const resolved = expandDefaults(entries, parseBulletBlock(defaultsBlock))
  if (resolved.length === 0) return ''
  return `\n${resolved.map(entry => `- ${entry}`).join('\n')}\n`
}

/** Human-readable reason, for the review screen and the CLI notes. */
export function describeDropReason(reason: RuleDropReason): string {
  switch (reason) {
    case 'empty':
      return 'empty entry'
    case 'control-characters':
      return 'contains control characters'
    case 'invisible-characters':
      return 'contains invisible or bidirectional characters'
    case 'settings-token':
      return 'contains a settings delimiter token'
    case 'too-long':
      return `longer than ${MAX_ENTRY_CHARS} characters`
    case 'over-entry-cap':
      return `beyond the ${MAX_ENTRIES_PER_SECTION}-entry limit`
    case 'too-broad':
      return 'too broad for auto mode to honor safely'
  }
}

/**
 * Privacy level controls how much nonessential network traffic and telemetry
 * Claude Code generates.
 *
 * Levels are ordered by restrictiveness:
 *   default < no-telemetry < essential-traffic
 *
 * - default:            Everything enabled.
 * - no-telemetry:       Analytics/telemetry disabled (Datadog, 1P events, feedback survey).
 * - essential-traffic:  ALL nonessential network traffic disabled
 *                       (telemetry + auto-updates, grove, release notes, model capabilities, etc.).
 *
 * Claudin defaults to `essential-traffic`: as a provider-agnostic fork, the
 * Anthropic-backend startup probes (bootstrap, quota warm, MCP registry,
 * fast-mode org status, grove, oauth account settings, …) are dead weight
 * for the typical user. Set `ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0`
 * (or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0`) to opt back in to the
 * upstream behaviour.
 *
 * Env-var resolution (most restrictive wins):
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0 / ANTHROPIC_…=0  →  default
 *     (explicit opt-in to nonessential traffic)
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / ANTHROPIC_…  →  essential-traffic
 *   DISABLE_TELEMETRY  →  no-telemetry (only when neither of the above is set)
 *   unset             →  essential-traffic (Claudin default)
 */

type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

function isFalsy(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'no' || v === 'off' || v === ''
}

export function getPrivacyLevel(): PrivacyLevel {
  const claudeCode = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const anthropic = process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC

  // Explicit opt-in to nonessential traffic.
  if (
    (claudeCode !== undefined && isFalsy(claudeCode)) ||
    (anthropic !== undefined && isFalsy(anthropic))
  ) {
    if (process.env.DISABLE_TELEMETRY && !isFalsy(process.env.DISABLE_TELEMETRY)) {
      return 'no-telemetry'
    }
    return 'default'
  }

  // Anything else (set truthy or unset) → essential-traffic (Claudin default).
  return 'essential-traffic'
}

/**
 * True when all nonessential network traffic should be suppressed.
 * Equivalent to the old `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` check.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * True when telemetry/analytics should be suppressed.
 * True at both `no-telemetry` and `essential-traffic` levels.
 */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/**
 * Returns the env var name responsible for the current essential-traffic restriction,
 * or null if unrestricted. Used for user-facing "unset X to re-enable" messages.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (!isEssentialTrafficOnly()) return null
  const claudeCode = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  if (claudeCode !== undefined && !isFalsy(claudeCode)) {
    return 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  const anthropic = process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC
  if (anthropic !== undefined && !isFalsy(anthropic)) {
    return 'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  // Claudin default (no env var set).
  return 'claudin-default'
}

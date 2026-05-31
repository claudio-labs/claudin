// The base system prompt in src/constants/prompts.ts is already calibrated
// for Claude models (Claudio promotes several Claude-tuned bullets that
// openclaude keeps gated behind USER_TYPE === 'ant'). Adding another block
// here would double-dose the no-comments rule, false-claims mitigation, and
// verify-before-completion guidance. Kept as null on purpose — file exists
// so the decision is visible next to the other families and we can evolve
// it later without touching the resolver.
export const ANTHROPIC_ADDENDUM: string | null = null

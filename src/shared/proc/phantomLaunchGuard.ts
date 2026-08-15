/**
 * Phantom-launch detection heuristic.
 *
 * The model sometimes *narrates* dispatching agents in prose ("2 agents
 * launched in the background, I'll report back") without ever emitting the
 * `Agent` tool call — so nothing actually runs and the user is left waiting for
 * results that never arrive. The prompt edits in src/tools/AgentTool/prompt.ts
 * and src/agent/coordinator/coordinatorMode.ts reduce how often this happens; the
 * runtime guard in query.ts is the deterministic floor that catches the rest.
 *
 * `claimsAgentLaunch` answers one narrow question: does this assistant text read
 * like an announcement that *agents* were just launched / are now running?
 *
 * Key precision rule learned from review: a launch cue ("running in the
 * background", "kicked off", "in parallel") is ordinary prose about builds,
 * servers, and test suites unless it sits next to an actual agent noun. So we
 * require an `agent`/`agente`/`subagent` token *adjacent* to a launch cue —
 * "the tests are running in parallel" must NOT trip, "two agents running in
 * parallel" must. This deliberately misses agents referred to only by
 * description ("migration audit running in the background"); those are
 * indistinguishable from a build, and the prompt layer is what reduces them.
 *
 * Covers EN and PT-BR, the two languages observed in the wild.
 */

// The noun that makes a sentence specifically about agents.
const AGENT = String.raw`(?:sub[-\s]?agents?|agents?|subagentes?|agentes?)`

// "just launched / now running" cues, EN + PT. Bare "running" is intentionally
// excluded (collides with "running the agent tests"); only qualified forms
// ("now running", "running in the background", PT "rodando") count.
const LAUNCH = String.raw`(?:launch(?:ed|ing)?|dispatch(?:ed|ing)?|kick(?:ed|ing)?\s+off|spun\s+up|spin(?:ning)?\s+up|fir(?:ed|ing)?\s+off|delegat(?:ed|ing)?|off\s+and\s+running|now\s+running|are\s+running|in\s+the\s+background|in\s+parallel|disparei|disparand[oa]|disparad[oa]s?|lancei|lan[çc]ei|lançad[oa]s?|deleguei|iniciei|rodando|em\s+background|em\s+paralelo|em\s+segundo\s+plano)`

// Up to ~40 non-sentence-ending chars between the agent noun and the cue.
const NEAR = String.raw`[^.!?\n]{0,40}`

const LAUNCH_SIGNALS = [
  new RegExp(String.raw`\b${AGENT}\b${NEAR}\b${LAUNCH}\b`),
  new RegExp(String.raw`\b${LAUNCH}\b${NEAR}\b${AGENT}\b`),
]

// Talking *about* launching agents (docs/explanations/conditionals) is not a
// claim that one just happened. PT phrases use plain substrings, not \b: an
// accented char like the "ê" in "você" is non-word to ASCII \b, which would
// silently break a trailing boundary.
const EXPLANATORY = [
  /\b(when you|if you|whenever you|you can|to launch|how to|in order to|once you)\b/,
  /quando você|se você|você pode|para (disparar|lançar|rodar)|como (disparar|lançar|rodar)|caso você/,
]

// Sentences that match a launch signal but are NOT a live launch claim. The
// hard lesson from review: scope every suppressor to the agent/launch span. A
// global "contains not/done/não" pass swallows real phantoms whose negation is
// in an *unrelated* clause ("launched 2 agents — not going to wait", "spun up
// agents without blocking you", "Done — I'll report back"). The benign cases we
// DO want to drop have the negation/completion governing the launch itself:
// "no agents were launched", "the agent finished". So we only suppress when the
// negator/completion sits within a couple words of the agent noun or launch cue.

// Launch verbs/cues used for proximity scoping (peer of LAUNCH, action-only).
const LAUNCH_CUE = String.raw`(?:launch(?:ed|ing)?|dispatch(?:ed|ing)?|kick(?:ed|ing)?\s+off|sp(?:un|in(?:ning)?)\s+up|fir(?:ed|ing)?\s+off|delegat(?:ed|ing)?|in\s+parallel|in\s+the\s+background|disparei|disparand[oa]|disparad[oa]s?|lancei|lan[çc]ei|lançad[oa]s?|deleguei|iniciei|rodando|em\s+background|em\s+paralelo|em\s+segundo\s+plano)`

// Up to N intervening words before the thing being negated / the completion.
const GAP2 = String.raw`(?:\s+\S+){0,2}\s+`
const GAP3 = String.raw`(?:\s+\S+){0,3}\s+`

// EN+PT negators (bare "no" excluded — it's also PT "no" = em+o "in the").
const NEG = String.raw`(?:not|never|without|none|failed|unable|declined|refus(?:e|ed)|não|nunca|nenhum[ao]?s?|sem)`
// Past-tense completion / terminal verbs (NOT bare "finish"/"complete" — the
// real future-tense phantom "report back when they finish" must still fire).
const COMPLETION = String.raw`finished|completed|returned|came\s+back|wrapped\s+up|crashed|errored|timed\s+out|hung|stalled|failed|terminou|terminaram|terminad[oa]s?|conclu(?:í|iu|íram|íd[oa]s?)|finalizou|finalizaram|voltou|voltaram|retornou|retornaram|travou|quebrou|falhou`

const SUPPRESS = [
  // "no agents" — "no" directly qualifying an agent noun (EN-only; PT "no" homograph)
  new RegExp(String.raw`\bno\s+(?:more\s+)?${AGENT}\b`),
  // negator governing the agent or the launch verb within ~2 words ("didn't
  // dispatch", "never launched the agent", "doesn't run in parallel")
  new RegExp(String.raw`\b${NEG}\b${GAP2}(?:${AGENT}|${LAUNCH_CUE})`),
  new RegExp(String.raw`\w*n['’]t\b${GAP2}(?:${AGENT}|${LAUNCH_CUE})`),
  // completion/terminal verb within ~3 words after an agent noun ("the agent
  // finished", "os agentes voltaram", "the agent crashed while a build ran")
  new RegExp(String.raw`\b${AGENT}\b${GAP3}(?:${COMPLETION})\b`),
  // standalone completion phrases specific enough to imply a prior run
  /\bno longer running\b/,
  /\b(?:already (?:back|done|finished|returned)|results? (?:are|is) (?:in|back))\b/,
  /\bjá (?:voltou|terminou|concluiu)\b/,
]

export function claimsAgentLaunch(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (EXPLANATORY.some(re => re.test(t))) return false
  if (SUPPRESS.some(re => re.test(t))) return false
  return LAUNCH_SIGNALS.some(re => re.test(t))
}

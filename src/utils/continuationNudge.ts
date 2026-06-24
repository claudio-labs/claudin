/**
 * Continuation-nudge detection.
 *
 * The agent loop (src/query.ts) injects a "keep going" meta message when the
 * model ends a turn that *reads* like it intends to continue but emitted no
 * tool calls — preventing premature task completion. This module is the pure,
 * testable detector behind that decision.
 *
 * Two signals:
 *
 *  1. Phrase intent — the model said it is about to act ("now I'll create…",
 *     "agora vou editar…", "ahora voy a crear…") without a completion marker
 *     ("done", "pronto", "listo"). Covered for EN + PT-BR + ES, organized as
 *     one `{ continuation, continuationShort, completion }` block per language
 *     so adding a language later is localized.
 *
 *  2. Structural incompleteness — the message ends inside an unclosed ``` code
 *     fence (odd number of fence runs). This is language-independent and the
 *     fallback for any language we don't carry phrase vocab for.
 *
 * Precision lessons borrowed from src/utils/phantomLaunchGuard.ts: accented
 * characters are non-word to ASCII `\b`, so PT/ES tokens that touch an accent
 * use plain substrings rather than a trailing boundary; and homographs must be
 * guarded ("pronto para" / "listo para" = "ready to", NOT a completion).
 *
 * A completion marker only suppresses the *phrase* signal — an unclosed fence
 * is unambiguous truncation and nudges regardless.
 */

// Bare action-verb alternations, wrapped at each use site.
const EN_VERB = String.raw`do|create|write|edit|update|fix|implement|add|run|check|make|build|set up`
const PT_VERB = String.raw`criar|editar|atualizar|rodar|executar|implementar|corrigir|adicionar|fazer|escrever|configurar|ajustar|verificar|checar|come[çc]ar|proceder|prosseguir|continuar|gerar|instalar|testar`
const ES_VERB = String.raw`crear|editar|actualizar|ejecutar|correr|implementar|corregir|a[ñn]adir|agregar|hacer|escribir|configurar|revisar|empezar|comenzar|proceder|continuar|generar|instalar|probar`

type LangBlock = {
  /** Continuation intent — applied at any length. */
  continuation: RegExp[]
  /** Weaker continuation intent — only applied to short messages (< SHORT_LEN). */
  continuationShort: RegExp[]
  /** Completion markers — suppress the phrase signal. */
  completion: RegExp[]
}

// Short-message gate: the weaker "I'll/preciso/voy a + verb" patterns are
// prone to matching long explanatory prose, so they only count when the whole
// message is brief. Mirrors the original query.ts heuristic.
const SHORT_LEN = 80

const EN: LangBlock = {
  continuation: [
    new RegExp(String.raw`\bso now (i|let me|we) (need to|have to|should|must|will) (?:${EN_VERB})\b`),
    new RegExp(String.raw`\bnow i('ll| will) (?:${EN_VERB}|go|proceed)\b`),
    new RegExp(String.raw`\blet me (go ahead and |now )?(?:${EN_VERB}|proceed)\b`),
    /\btime to (do|create|write|edit|update|fix|implement|add|run|check|make|build|get started|begin)\b/,
  ],
  continuationShort: [
    new RegExp(String.raw`\bi('ll| will| need to| have to| must) (now )?(?:${EN_VERB})\b`),
    /\bnext,?\s+(i('ll| will)|let me|i need to) (do|create|write|edit|update|fix|implement|add|run|check|make|build)\b/,
  ],
  completion: [
    /\b(done|finished|completed|complete|summary|that's all|that is all|all set|hope this helps|let me know if)\b/,
  ],
}

const PT: LangBlock = {
  continuation: [
    new RegExp(String.raw`\b(agora vou|vou agora|j[áa] vou) (?:${PT_VERB})`),
    new RegExp(String.raw`\b(agora preciso|preciso agora|vou precisar) (?:de )?(?:${PT_VERB})`),
    new RegExp(String.raw`\b(deixa|deixe) eu (?:${PT_VERB})`),
    new RegExp(String.raw`\bhora de (?:${PT_VERB})`),
    new RegExp(String.raw`\bent[ãa]o,? agora (vou|preciso) (?:de )?(?:${PT_VERB})`),
  ],
  continuationShort: [
    new RegExp(String.raw`\bpreciso (?:de )?(?:${PT_VERB})`),
    new RegExp(String.raw`\bvou (?:${PT_VERB})`),
    /\bpr[óo]ximo passo/,
  ],
  // Accented tokens use substrings (no trailing \b). "pronto para"/"pronto pra"
  // = "ready to" must NOT count. "concluindo"/"finalizando" are mid-action, not
  // completion, so the patterns exclude the gerund.
  completion: [
    /\bpronto\b(?!\s+(?:para|pra)\b)/,
    /conclu[íi](?!ndo)/,
    /finaliz(?:ei|ad[oa]|ou)/,
    /termin(?:ei|ad[oa]|ou|amos)/,
    /\bfeito\b(?!\s+isso\b)/,
    /(?:^|[\s,.;!?])(?:é|era) isso\b/,
    /\bisso é tudo\b/,
    /espero (?:que (?:isso |isto )?ajude|ter ajudado)/,
    /qualquer d[úu]vida/,
    /\bme avis[ea]\b/,
  ],
}

const ES: LangBlock = {
  continuation: [
    new RegExp(String.raw`\bahora voy a (?:${ES_VERB})`),
    new RegExp(String.raw`\bd[ée]jame (?:${ES_VERB})`),
    new RegExp(String.raw`\b(necesito|tengo que) (?:${ES_VERB})`),
    new RegExp(String.raw`\bvamos a (?:${ES_VERB})`),
    new RegExp(String.raw`\bes hora de (?:${ES_VERB})`),
  ],
  continuationShort: [
    new RegExp(String.raw`\bvoy a (?:${ES_VERB})`),
    /\bsiguiente paso/,
  ],
  completion: [
    /\blisto\b(?!\s+para\b)/,
    // Accent-only preterite (terminé/completé/finalicé). A bare-`e` class here
    // ([ée]) would match English "complete"/"finalize"/"determine" and wrongly
    // suppress nudges on English continuation text.
    /termin(?:ad[oa]|é)/,
    /complet(?:ad[oa]|é)/,
    // "finalicé" (z→c before e), not "finalizé"; participle stays "finalizad[oa]".
    /finali(?:zad[oa]|cé)/,
    /\bhecho\b(?!\s+esto\b)/,
    /eso es todo/,
    /espero que (?:esto |eso )?ayude/,
    /cualquier duda/,
    /av[íi]same/,
  ],
}

const BLOCKS: LangBlock[] = [EN, PT, ES]

// Three or more backticks = a fence run. An odd total across the message means
// a fence was opened and never closed → the message was cut off mid-block.
const FENCE_RUN_RE = /`{3,}/g

/**
 * True when the text reads like the model intends to keep working (any
 * supported language). Weaker patterns only count for short messages.
 */
export function signalsContinuation(text: string): boolean {
  const t = text.toLowerCase()
  const short = t.length < SHORT_LEN
  for (const block of BLOCKS) {
    if (block.continuation.some(re => re.test(t))) return true
    if (short && block.continuationShort.some(re => re.test(t))) return true
  }
  return false
}

/** True when the text carries a completion marker (any supported language). */
export function signalsCompletion(text: string): boolean {
  const t = text.toLowerCase()
  return BLOCKS.some(block => block.completion.some(re => re.test(t)))
}

/** True when the message ends inside an unclosed ``` code fence. */
export function isStructurallyIncomplete(text: string): boolean {
  return ((text.match(FENCE_RUN_RE)?.length ?? 0) % 2) === 1
}

/**
 * Whether the agent loop should nudge the model to continue. A completion
 * marker suppresses the phrase signal; an unclosed fence nudges regardless.
 */
export function shouldNudgeContinuation(text: string): boolean {
  if (!text.trim()) return false
  return (
    (signalsContinuation(text) && !signalsCompletion(text)) ||
    isStructurallyIncomplete(text)
  )
}

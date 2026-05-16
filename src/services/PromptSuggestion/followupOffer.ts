// Strip fenced code blocks so a trailing ``` doesn't hide the real ending.
const FENCED_CODE_RE = /```[\s\S]*?```/g
// Trailing whitespace + closing punctuation we tolerate after the offer.
const TRAILING_PUNCT_RE = /[\s)"'`*_>\]]+$/
// Phrases that indicate the assistant is offering a next step to the user.
// Includes pt-BR and en variants. Anchored to end-of-text (after trimming).
// Kept narrow on purpose — verbs like "continuo" / "prossigo" / "next step"
// are common in narration too; we only match explicit second-person offers.
// "quer <infinitivo>" covers the natural pt-BR offer form ("Quer commitar.",
// "Quer ver o diff.", "Quer abrir um PR."). Verb-shape (ar/er/ir) plus the
// requirement to be near the end of text keeps narration ("…quer dizer que…")
// from matching, since the offer needs to be the *final* phrase.
const FOLLOWUP_OFFER_RE =
  /\b(?:quer que (?:eu|nós)|quer (?:que )?(?!dizer\b)[a-záéíóúâêôãõç]+(?:ar|er|ir)|posso (?:rodar|abrir|criar|aplicar|commitar|comitar)|deseja (?:que|rodar)|gostaria (?:que|de)|devo (?:rodar|criar|abrir|aplicar|commitar|comitar|prosseguir|continuar)|want me to|shall i|should i (?:run|continue|open|create|apply|commit|proceed)|would you like (?:me to|to)|do you want (?:me to|to)|let me know)\b[^.!?]{0,80}[?.!]?\s*$/i

/**
 * Returns true when the assistant's last reply ends with a follow-up offer
 * (question, suggestion, or proposed next step) — i.e. the user is being
 * invited to respond. Used to gate prompt-suggestion generation so we don't
 * surface ghost text when the assistant simply reported a result.
 */
export function endsWithFollowupOffer(text: string): boolean {
  if (!text) return false
  const stripped = text.replace(FENCED_CODE_RE, '').trim()
  if (!stripped) return false
  const tail = stripped.replace(TRAILING_PUNCT_RE, '')
  if (!tail) return false
  if (/[?？]$/.test(tail)) return true
  return FOLLOWUP_OFFER_RE.test(tail)
}

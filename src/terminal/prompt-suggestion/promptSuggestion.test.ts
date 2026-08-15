import { describe, expect, test } from 'bun:test'
import { endsWithFollowupOffer } from 'src/terminal/prompt-suggestion/followupOffer.js'

describe('endsWithFollowupOffer', () => {
  test('returns false for empty / whitespace text', () => {
    expect(endsWithFollowupOffer('')).toBe(false)
    expect(endsWithFollowupOffer('   \n\n')).toBe(false)
  })

  test('returns true when text ends with a question mark (en/pt)', () => {
    expect(endsWithFollowupOffer('All set. Want to commit now?')).toBe(true)
    expect(endsWithFollowupOffer('Pronto. Quer rodar os tests?')).toBe(true)
  })

  test('returns true for pt-BR offer phrases without question mark', () => {
    expect(endsWithFollowupOffer('Feito. Posso rodar os testes.')).toBe(true)
    expect(endsWithFollowupOffer('Quer que eu commite agora.')).toBe(true)
    expect(endsWithFollowupOffer('Devo aplicar a mudança.')).toBe(true)
  })

  test('matches "Quer <infinitivo>." natural pt-BR offers', () => {
    expect(endsWithFollowupOffer('Build limpo. Quer commitar.')).toBe(true)
    expect(endsWithFollowupOffer('Quer ver o diff.')).toBe(true)
    expect(endsWithFollowupOffer('Quer abrir um PR.')).toBe(true)
    expect(endsWithFollowupOffer('Quer rodar os tests.')).toBe(true)
    expect(endsWithFollowupOffer('Quer aplicar agora.')).toBe(true)
  })

  test('does not match bare capability statements (regression)', () => {
    // "Posso seguir." is the assistant stating capability, not offering.
    expect(endsWithFollowupOffer('Tudo certo. Posso seguir.')).toBe(false)
    expect(endsWithFollowupOffer('Posso continuar.')).toBe(false)
    expect(endsWithFollowupOffer('Posso prosseguir sem problemas.')).toBe(false)
  })

  test('returns true for English offer phrases', () => {
    expect(endsWithFollowupOffer('Done. Want me to commit.')).toBe(true)
    expect(endsWithFollowupOffer('Done. Let me know.')).toBe(true)
    expect(endsWithFollowupOffer('Patched. Should I run the tests.')).toBe(true)
  })

  test('returns false when assistant just reported a result', () => {
    expect(endsWithFollowupOffer('I edited src/foo.ts and added the helper.')).toBe(false)
    expect(endsWithFollowupOffer('All tests passed.')).toBe(false)
  })

  test('does not match common narration verbs (regression — false positives)', () => {
    // These previously matched with a looser regex; keep them as negative tests.
    expect(endsWithFollowupOffer('Continuo trabalhando no fix.')).toBe(false)
    expect(endsWithFollowupOffer('Prossigo com a refatoração.')).toBe(false)
    expect(endsWithFollowupOffer('The next step is documented in the README.')).toBe(false)
    expect(endsWithFollowupOffer('Avanço para o próximo arquivo.')).toBe(false)
    // "quer dizer" is a narration idiom, not an offer.
    expect(endsWithFollowupOffer('Isso quer dizer que está ok.')).toBe(false)
    expect(endsWithFollowupOffer('O que quer dizer essa flag.')).toBe(false)
  })

  test('ignores trailing fenced code blocks', () => {
    const text = 'Quer rodar os tests?\n\n```bash\nbun test\n```'
    expect(endsWithFollowupOffer(text)).toBe(true)
  })

  test('tolerates trailing punctuation/whitespace around closer', () => {
    expect(endsWithFollowupOffer('Quer rodar os tests?  ')).toBe(true)
    expect(endsWithFollowupOffer('Want me to commit?\n')).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  isStructurallyIncomplete,
  shouldNudgeContinuation,
  signalsCompletion,
  signalsContinuation,
} from 'src/utils/continuationNudge.js'

describe('signalsContinuation — positives (intent to keep working)', () => {
  const positives = [
    // EN — preserved from the original query.ts heuristic
    'So now I have to implement the parser.',
    "Now I'll edit the config.",
    'Let me run the tests.',
    'Time to build the project.',
    // EN short-gated patterns (< 80 chars)
    "I'll fix the bug.",
    "Next, I'll add the test.",
    // PT-BR
    'Agora vou criar o arquivo.',
    'Vou agora editar o config.',
    'Deixa eu rodar os testes.',
    'Hora de implementar isso.',
    'Então agora vou corrigir o bug.',
    'Preciso rodar os testes.',
    'Vou criar o arquivo.',
    'Próximo passo: configurar o build.',
    // ES
    'Ahora voy a crear el archivo.',
    'Déjame ejecutar las pruebas.',
    'Necesito corregir el error.',
    'Vamos a implementar esto.',
    'Es hora de escribir el código.',
    'Voy a crear el archivo.',
    'Siguiente paso: configurar.',
  ]
  for (const text of positives) {
    test(text.slice(0, 52), () => {
      expect(signalsContinuation(text)).toBe(true)
    })
  }
})

describe('signalsContinuation — negatives (no live action intent)', () => {
  const negatives = [
    'I explained how the function works.',
    'Let me think about this for a moment.',
    "Now I'll explain the approach in detail.",
    'Deixa eu explicar a abordagem.',
    'Vou pensar sobre isso.',
    'Voy a pensar en ello.',
    // "i need to do" present but the message is long → short-gate excludes it
    'In this codebase there are a great many considerations to weigh, and eventually I need to do something here.',
    '',
  ]
  for (const text of negatives) {
    test(text.slice(0, 52) || '(empty)', () => {
      expect(signalsContinuation(text)).toBe(false)
    })
  }
})

describe('signalsCompletion — positives (task done markers)', () => {
  const positives = [
    // EN
    'Done.',
    'All finished.',
    "That's all.",
    'Hope this helps.',
    'Let me know if you need anything.',
    // PT-BR
    'Pronto.',
    'Concluí a tarefa.',
    'Finalizei tudo.',
    'Terminei.',
    'Feito.',
    'É isso.',
    'Isso é tudo.',
    'Espero que ajude.',
    'Qualquer dúvida, me avisa.',
    'Me avise se precisar.',
    // ES
    'Listo.',
    'Terminado.',
    'Completado.',
    'Hecho.',
    'Eso es todo.',
    'Espero que ayude.',
    'Cualquier duda, avísame.',
  ]
  for (const text of positives) {
    test(text.slice(0, 52), () => {
      expect(signalsCompletion(text)).toBe(true)
    })
  }
})

describe('signalsCompletion — false-positive guards (must NOT fire)', () => {
  const negatives = [
    // "pronto/listo para" = "ready to", not "done"
    'Pronto para começar.',
    'Listo para crear el archivo.',
    // gerund = mid-action, not completion
    'Estou concluindo agora.',
    // "feito isso" = "that done, …" introduces more work
    'Feito isso, agora vou testar.',
    // plain continuation prose
    'Agora vou criar o arquivo.',
    'I will run the tests next.',
  ]
  for (const text of negatives) {
    test(text.slice(0, 52), () => {
      expect(signalsCompletion(text)).toBe(false)
    })
  }
})

describe('isStructurallyIncomplete — unclosed code fence', () => {
  test('open fence with no close', () => {
    expect(
      isStructurallyIncomplete('Here is the code:\n```ts\nconst x = 1'),
    ).toBe(true)
  })
  test('open fence at end of message', () => {
    expect(isStructurallyIncomplete('Let me write it:\n```python')).toBe(true)
  })
  test('balanced fence is complete', () => {
    expect(
      isStructurallyIncomplete('```ts\nconst x = 1\n```'),
    ).toBe(false)
  })
  test('no fences at all', () => {
    expect(isStructurallyIncomplete('just some prose, no code')).toBe(false)
  })
  test('inline single backticks do not count', () => {
    expect(isStructurallyIncomplete('use the `foo` helper here')).toBe(false)
  })
})

describe('shouldNudgeContinuation — combined decision', () => {
  test('phrase intent without completion → nudge', () => {
    expect(shouldNudgeContinuation('Agora vou criar o arquivo.')).toBe(true)
  })
  test('completion marker suppresses the phrase signal', () => {
    expect(shouldNudgeContinuation('Pronto, finalizei tudo.')).toBe(false)
  })
  test('unclosed fence nudges even with a completion marker present', () => {
    expect(shouldNudgeContinuation('Done.\n```ts\nconst x = 1')).toBe(true)
  })
  test('complete fenced answer with no intent → no nudge', () => {
    expect(
      shouldNudgeContinuation(
        "Here's the result:\n```ts\nconst x = 1\n```\nDone.",
      ),
    ).toBe(false)
  })
  test('plain explanation → no nudge', () => {
    expect(
      shouldNudgeContinuation('I explained the architecture in detail.'),
    ).toBe(false)
  })
  test('empty text → no nudge', () => {
    expect(shouldNudgeContinuation('')).toBe(false)
  })

  // The bug-catcher: an input that carries BOTH a continuation signal AND a
  // completion marker must NOT nudge. The earlier "completion suppresses" case
  // had no continuation signal, so dropping `&& !signalsCompletion` left it green.
  test('completion suppresses even when continuation intent is also present', () => {
    const text = 'Agora vou criar o arquivo. Pronto, terminei.'
    expect(signalsContinuation(text)).toBe(true)
    expect(signalsCompletion(text)).toBe(true)
    expect(shouldNudgeContinuation(text)).toBe(false)
  })

  test('both signals + unclosed fence still nudges (fence overrides)', () => {
    const text = 'Agora vou criar o arquivo. Pronto.\n```ts\nconst x = 1'
    expect(signalsContinuation(text)).toBe(true)
    expect(signalsCompletion(text)).toBe(true)
    expect(shouldNudgeContinuation(text)).toBe(true)
  })
})

describe('English false-completion guard (ES preterite class must be accent-only)', () => {
  // A bare-`e` class in the ES `termin/complet/finaliz` completion patterns
  // would match English "finalize"/"completely"/"determine" and suppress nudges.
  test('"finalize" is not a completion marker', () => {
    expect(signalsCompletion('Let me finalize the database migration script.')).toBe(
      false,
    )
  })
  test('"completely/incomplete/undetermined" are not completion markers', () => {
    expect(
      signalsCompletion('This is completely incomplete and undetermined.'),
    ).toBe(false)
  })
  test('continuation with English "finalize" still nudges', () => {
    expect(
      shouldNudgeContinuation('Let me edit the migration to finalize the schema.'),
    ).toBe(true)
  })
  // Real ES accented preterites must still register as completion.
  test('ES "completé" (accented) is a completion marker', () => {
    expect(signalsCompletion('Completé el trabajo.')).toBe(true)
  })
  // Correct ES preterite of "finalizar" is "finalicé" (z→c before e), not "finalizé".
  test('ES "finalicé" (z→c) is a completion marker', () => {
    expect(signalsCompletion('Finalicé la tarea.')).toBe(true)
  })
  test('ES "finalizado" participle is still a completion marker', () => {
    expect(signalsCompletion('Ya está finalizado.')).toBe(true)
  })
})

describe('completion markers that other tests left as surviving mutants', () => {
  // EN "completed"/"complete": no ES pattern matches the English words, so the
  // EN completion list is the only matcher — removing it would go undetected
  // without these.
  test('EN "completed" is a completion marker', () => {
    expect(signalsCompletion('Task completed.')).toBe(true)
  })
  test('EN "complete" is a completion marker', () => {
    expect(signalsCompletion('The build is complete.')).toBe(true)
  })
  // PT "avisa" imperative — previously only reached via a message that also
  // matched "qualquer dúvida", masking the `avis[ea]` pattern.
  test('PT "me avisa" is a completion marker (isolated)', () => {
    expect(signalsCompletion('Me avisa.')).toBe(true)
  })
})

describe('PT "preciso agora" ordering isolated at length ≥ SHORT_LEN', () => {
  // ≥ 80 chars disables the short `preciso`/`vou` patterns, and "preciso agora"
  // (not "agora preciso") can only match the `preciso agora` alternation.
  const text =
    'Depois de revisar a estrutura inteira do projeto com calma, preciso agora editar o arquivo.'
  test(`fires (len ${text.length})`, () => {
    expect(text.length).toBeGreaterThanOrEqual(80)
    expect(signalsContinuation(text)).toBe(true)
  })
})

describe('non-short patterns isolated at length ≥ SHORT_LEN', () => {
  // Each input is ≥ 80 chars so the short-gated patterns are off — only the
  // named non-short pattern can make it true, so a regression in that pattern
  // is caught here.
  const cases: Array<[string, string]> = [
    [
      'EN "so now …"',
      'After reviewing the entire module very carefully, so now I have to implement the parser.',
    ],
    [
      'EN "now i will …"',
      'I spent a while reading through the existing code, and now I will update the parser today.',
    ],
    [
      'PT "agora preciso …"',
      'Depois de analisar o módulo inteiro com bastante calma, agora preciso editar o arquivo.',
    ],
    [
      'PT "vou precisar …"',
      'Depois de revisar tudo com bastante cuidado, vou precisar criar um novo arquivo de teste.',
    ],
    [
      'ES "ahora voy a …"',
      'Después de revisar todo el código con mucho cuidado, ahora voy a crear el archivo aquí.',
    ],
  ]
  for (const [name, text] of cases) {
    test(`${name} (len ${text.length})`, () => {
      expect(text.length).toBeGreaterThanOrEqual(80)
      expect(signalsContinuation(text)).toBe(true)
    })
  }
})

describe('language-isolated completion markers (break cross-language masking)', () => {
  test('PT-only "Terminamos."', () => {
    expect(signalsCompletion('Terminamos.')).toBe(true)
  })
  test('ES-only "Completé el trabajo."', () => {
    expect(signalsCompletion('Completé el trabajo.')).toBe(true)
  })
})

describe('SHORT_LEN boundary is pinned', () => {
  const shortPos = 'I need to run the suite now to verify the change works fine.'
  const longNeg =
    'I need to run the suite now to verify the recent change really works fine here today.'
  test('short message fires the gated pattern', () => {
    expect(shortPos.length).toBeLessThan(80)
    expect(signalsContinuation(shortPos)).toBe(true)
  })
  test('same prefix past the gate does not fire', () => {
    expect(longNeg.length).toBeGreaterThanOrEqual(80)
    expect(signalsContinuation(longNeg)).toBe(false)
  })
})

describe('verb-list typo guards (currently unexercised verbs)', () => {
  test('PT "gerar"', () => {
    expect(signalsContinuation('Vou gerar o relatório.')).toBe(true)
  })
  test('ES "agregar"', () => {
    expect(signalsContinuation('Voy a agregar la prueba.')).toBe(true)
  })
})

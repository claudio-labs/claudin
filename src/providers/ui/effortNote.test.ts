import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetOllamaModelInfoForTesting,
  _setOllamaModelInfoForTesting,
} from 'src/providers/model/ollamaModelInfo.js'
import { effortUnavailableNote } from 'src/providers/ui/effortNote.js'

afterEach(() => {
  _resetOllamaModelInfoForTesting()
})

describe('effortUnavailableNote', () => {
  test('a model with no effort control: "not supported", named or not', () => {
    expect(effortUnavailableNote('glm-5.3-flash', 'glm-5.3-flash')).toBe('Effort not supported for glm-5.3-flash')
    expect(effortUnavailableNote('glm-5.3-flash', 'this model')).toBe('Effort not supported for this model')
    expect(effortUnavailableNote(undefined)).toBe('Effort not supported')
  })

  test('an Ollama model that thinks on or off points at the Thinking toggle', () => {
    _setOllamaModelInfoForTesting('qwen3:8b', { thinking: true, thinkingLevels: false })
    expect(effortUnavailableNote('qwen3:8b', 'this model')).toBe(
      'Thinking only turns on or off for this model · /config → Thinking',
    )
  })

  test('an Ollama model that does not think stays "not supported"', () => {
    _setOllamaModelInfoForTesting('llama3.1:8b', { thinking: false, thinkingLevels: false })
    expect(effortUnavailableNote('llama3.1:8b', 'llama3.1:8b')).toBe('Effort not supported for llama3.1:8b')
  })
})

import { describe, expect, test } from 'bun:test'

import { buildInputClipStub } from 'src/agent/compact/stableStubState/clipStubText.js'
import { clipStubEchoRefusal } from 'src/agent/tools/clipStubEcho.js'

// The tools' own `clearableInputFields`.
const PATCH = ['patchText']
const EDIT = ['old_string', 'new_string']
const WRITE = ['content']

describe('clipStubEchoRefusal', () => {
  test('a Patch body that is its own stub is refused, naming the field', () => {
    const patchText = buildInputClipStub('Patch', 'patchText', 931)
    const message = clipStubEchoRefusal({ patchText }, PATCH)
    expect(message).toContain('`patchText` is `[clipped: ~931 tokens of patchText from Patch]`')
    expect(message).toContain('Nothing was run')
  })

  test('an Edit whose new_string is the stub is refused', () => {
    // The 2026-10-10 case: it wrote the stub into toolResultStorage.test.ts.
    const new_string = buildInputClipStub('Edit', 'new_string', 723)
    expect(
      clipStubEchoRefusal({ file_path: '/a.ts', old_string: 'x', new_string }, EDIT),
    ).toContain('`new_string`')
  })

  test('replacing a stub that landed in a file goes through', () => {
    const old_string = buildInputClipStub('Edit', 'new_string', 723)
    expect(
      clipStubEchoRefusal({ file_path: '/a.ts', old_string, new_string: 'real' }, EDIT),
    ).toBeNull()
  })

  test('a stub mentioned inside real content is content', () => {
    const stub = buildInputClipStub('Write', 'content', 50)
    expect(clipStubEchoRefusal({ content: `the stub reads ${stub}` }, WRITE)).toBeNull()
  })

  test('a field the relief policy never stubs is never refused', () => {
    // A Grep for the stub text itself, or a tool with no clearable fields.
    const pattern = buildInputClipStub('Grep', 'pattern', 931)
    expect(clipStubEchoRefusal({ pattern }, undefined)).toBeNull()
    expect(clipStubEchoRefusal({ pattern }, [])).toBeNull()
    expect(clipStubEchoRefusal({ pattern, content: 'x' }, WRITE)).toBeNull()
  })

  test('only a string field can be a stub', () => {
    const stub = buildInputClipStub('Patch', 'patchText', 931)
    expect(clipStubEchoRefusal({ patchText: [stub] }, PATCH)).toBeNull()
  })

  test('non-object input is left alone', () => {
    expect(clipStubEchoRefusal(null, PATCH)).toBeNull()
    expect(clipStubEchoRefusal('[clipped: ~1 tokens of x from Y]', ['x'])).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import {
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  renderPromptTemplate,
} from 'src/tools/FileReadTool/prompt.js'

describe('Read tool prompt — multi-file investigation guidance', () => {
  const prompt = renderPromptTemplate(
    LINE_FORMAT_INSTRUCTION,
    '',
    OFFSET_INSTRUCTION_DEFAULT,
  )

  test('names the serial-read loop as the shape to avoid', () => {
    // This is the point of the whole block; the alternatives it offers can
    // change, but a version without the diagnosis stops steering anything.
    expect(prompt).toContain('When the task spans more than ~2 files')
    expect(prompt).toContain('A serial loop of Read')
  })

  test('offers same-turn parallel Reads as an alternative', () => {
    expect(prompt).toContain(
      'emit the Reads as parallel tool_use blocks in the same assistant message',
    )
  })

  test('offers a fork as the first alternative, and names no built-in agent', () => {
    // This block is NOT gated on the tool registry — it ships whether or not
    // any given agent exists. It used to name `subagent_type='Explore'`, which
    // is why removing that agent had to change this line too. A fork needs no
    // agent to be registered, so the claim stays true; the conditional opener
    // is what keeps it honest when the Agent tool is absent entirely.
    expect(prompt).toContain('If the Agent tool is available, fork yourself')
    expect(prompt).not.toContain('Explore')
    expect(prompt).not.toContain('subagent_type=')
  })
})

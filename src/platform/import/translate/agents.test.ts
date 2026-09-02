import { expect, test } from 'bun:test'

import {
  agentNameFromFileName,
  OPENCODE_AGENT_DIALECT,
  QWEN_AGENT_DIALECT,
  translateMarkdownAgent,
  translateYamlAgent,
} from 'src/platform/import/translate/agents.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

function expectOk(translation: ReturnType<typeof translateMarkdownAgent>) {
  if (!translation.ok) {
    throw new Error(`expected a translation, got: ${translation.reason}`)
  }
  return translation.agent
}

test('an agent name is normalised into an identifier the user can type', () => {
  expect(agentNameFromFileName('Code Reviewer.md')).toBe('code-reviewer')
  expect(agentNameFromFileName('build.yaml')).toBe('build')
  expect(agentNameFromFileName('__weird__.md')).toBe('weird')
})

test('an opencode agent keeps its description and gains the name we load by', () => {
  const agent = expectOk(
    translateMarkdownAgent(
      'reviewer.md',
      [
        '---',
        'description: Reviews diffs for correctness',
        'mode: subagent',
        '---',
        '',
        'You review diffs.',
      ].join('\n'),
      OPENCODE_AGENT_DIALECT,
    ),
  )
  const parsed = parseFrontmatter(agent.markdown)
  expect(parsed.frontmatter.name).toBe('reviewer')
  expect(parsed.frontmatter.description).toBe('Reviews diffs for correctness')
  expect(parsed.content.trim()).toBe('You review diffs.')
  expect(agent.relativePath).toBe('reviewer.md')
})

test('a foreign tools list is explained, not copied, so the agent keeps its tools', () => {
  const agent = expectOk(
    translateMarkdownAgent(
      'r.md',
      [
        '---',
        'description: d',
        'tools:',
        '  - read_file',
        '  - run_shell_command',
        '---',
        '',
        'body',
      ].join('\n'),
      QWEN_AGENT_DIALECT,
    ),
  )
  expect(parseFrontmatter(agent.markdown).frontmatter.tools).toBeUndefined()
  expect(agent.notes.join(' ')).toContain('tool names differ')
})

test('opencode mode, model and permission each get their own explanation', () => {
  const agent = expectOk(
    translateMarkdownAgent(
      'p.md',
      [
        '---',
        'description: d',
        'mode: primary',
        'model: anthropic/opus',
        'temperature: 0.2',
        '---',
        '',
        'body',
      ].join('\n'),
      OPENCODE_AGENT_DIALECT,
    ),
  )
  expect(agent.notes).toContain(
    'opencode "mode" has no equivalent — imported as a subagent',
  )
  expect(agent.notes.join(' ')).toContain('model ids are provider-qualified')
  expect(agent.notes).toContain('dropped frontmatter: temperature')
})

test('an agent with no description is refused rather than written as a dead file', () => {
  const result = translateMarkdownAgent(
    'x.md',
    '---\nmode: subagent\n---\n\nbody',
    OPENCODE_AGENT_DIALECT,
  )
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('description')
})

test('an agent with an empty system prompt is refused', () => {
  const result = translateMarkdownAgent(
    'x.md',
    '---\ndescription: d\n---\n\n  \n',
    OPENCODE_AGENT_DIALECT,
  )
  expect(result.ok).toBe(false)
})

test('Qwen colour survives, since it means the same thing on both sides', () => {
  const agent = expectOk(
    translateMarkdownAgent(
      'q.md',
      '---\ndescription: d\ncolor: cyan\n---\n\nbody',
      QWEN_AGENT_DIALECT,
    ),
  )
  expect(parseFrontmatter(agent.markdown).frontmatter.color).toBe('cyan')
})

test('a YAML agent moves its system prompt into the document body', () => {
  const translation = translateYamlAgent(
    'planner.yaml',
    {
      name: 'Planner',
      description: 'Plans work',
      systemPrompt: 'You plan.',
      tools: ['read_file'],
    },
    QWEN_AGENT_DIALECT,
  )
  const agent = expectOk(translation)
  expect(agent.name).toBe('planner')
  const parsed = parseFrontmatter(agent.markdown)
  expect(parsed.frontmatter.name).toBe('planner')
  expect(parsed.content.trim()).toBe('You plan.')
})

test('a YAML agent that only points at a prompt file is refused', () => {
  const result = translateYamlAgent(
    'a.yaml',
    { description: 'd', system_prompt_path: './prompt.md' },
    QWEN_AGENT_DIALECT,
  )
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('no inline system prompt')
})

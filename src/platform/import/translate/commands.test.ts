import { expect, test } from 'bun:test'

import {
  CODEX_PROMPT_DIALECT,
  commandDestinationPath,
  commandNameFromRelativePath,
  OPENCODE_COMMAND_DIALECT,
  QWEN_COMMAND_DIALECT,
  translateMarkdownCommand,
  translateTomlCommand,
} from 'src/platform/import/translate/commands.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

function expectOk(translation: ReturnType<typeof translateTomlCommand>) {
  if (!translation.ok) {
    throw new Error(`expected a translation, got: ${translation.reason}`)
  }
  return translation.command
}

test('a subdirectory becomes the command namespace, not part of the name', () => {
  expect(commandNameFromRelativePath('git/commit.toml')).toBe('git:commit')
  expect(commandNameFromRelativePath('review.md')).toBe('review')
  expect(commandDestinationPath('git/commit.toml')).toBe('git/commit.md')
  expect(commandDestinationPath('review.md')).toBe('review.md')
})

test('a Gemini TOML command becomes markdown with a description frontmatter', () => {
  const command = expectOk(
    translateTomlCommand('git/commit.toml', {
      description: 'Write a commit message',
      prompt: 'Summarise the staged diff for {{args}}.',
    }),
  )
  expect(command.name).toBe('git:commit')
  expect(command.relativePath).toBe('git/commit.md')

  const parsed = parseFrontmatter(command.markdown)
  expect(parsed.frontmatter.description).toBe('Write a commit message')
  expect(parsed.content.trim()).toBe('Summarise the staged diff for $ARGUMENTS.')
  expect(command.notes).toContain('rewrote {{args}} as $ARGUMENTS')
})

test('a TOML command with no description emits no frontmatter at all', () => {
  const command = expectOk(
    translateTomlCommand('plain.toml', { prompt: 'Just do it.' }),
  )
  expect(command.markdown).toBe('Just do it.\n')
})

test('a TOML command without a prompt is refused', () => {
  const result = translateTomlCommand('broken.toml', { description: 'x' })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('prompt')
})

test('a description containing a colon survives the YAML round trip', () => {
  const command = expectOk(
    translateTomlCommand('x.toml', {
      description: 'Fix: the thing, "properly"',
      prompt: 'body',
    }),
  )
  expect(parseFrontmatter(command.markdown).frontmatter.description).toBe(
    'Fix: the thing, "properly"',
  )
})

test('a Codex prompt crosses over unchanged, $ARGUMENTS included', () => {
  const command = expectOk(
    translateMarkdownCommand(
      'review.md',
      'Review $1 against $ARGUMENTS.',
      CODEX_PROMPT_DIALECT,
    ),
  )
  expect(command.markdown).toBe('Review $1 against $ARGUMENTS.\n')
  expect(command.notes).toEqual([])
})

test('opencode frontmatter we cannot honour is dropped and named in the notes', () => {
  const command = expectOk(
    translateMarkdownCommand(
      'ship.md',
      [
        '---',
        'description: Ship it',
        'agent: build',
        'model: anthropic/opus',
        'subtask: true',
        '---',
        '',
        'Ship the branch.',
      ].join('\n'),
      OPENCODE_COMMAND_DIALECT,
    ),
  )
  const parsed = parseFrontmatter(command.markdown)
  expect(parsed.frontmatter.description).toBe('Ship it')
  expect(parsed.frontmatter.model).toBeUndefined()
  expect(command.notes).toContain('dropped frontmatter: agent, model, subtask')
})

test('Qwen {{args}} is rewritten but $ARGUMENTS in a Codex prompt is not touched twice', () => {
  const qwen = expectOk(
    translateMarkdownCommand(
      'q.md',
      'Answer {{ args }} now.',
      QWEN_COMMAND_DIALECT,
    ),
  )
  expect(qwen.markdown).toContain('Answer $ARGUMENTS now.')

  const codex = expectOk(
    translateMarkdownCommand(
      'c.md',
      'Answer {{args}} now.',
      CODEX_PROMPT_DIALECT,
    ),
  )
  expect(codex.markdown).toContain('Answer {{args}} now.')
})

test("Gemini's inline injections are flagged rather than silently dropped", () => {
  const command = expectOk(
    translateTomlCommand('ctx.toml', {
      prompt: 'Given !{git diff} and @{README.md}, summarise.',
    }),
  )
  expect(command.notes).toEqual([
    'uses !{…} shell injection, which Claudin does not expand',
    'uses @{…} file injection, which Claudin does not expand',
  ])
})

test('an empty prompt body is refused rather than written as an empty command', () => {
  const result = translateMarkdownCommand(
    'empty.md',
    '---\ndescription: x\n---\n\n   \n',
    OPENCODE_COMMAND_DIALECT,
  )
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('no prompt body')
})

test('a path that escapes the commands directory is refused', () => {
  for (const bad of ['../../etc/passwd.md', '/abs/x.md', 'a/../../b.md']) {
    const result = translateMarkdownCommand(bad, 'body', CODEX_PROMPT_DIALECT)
    expect(result.ok).toBe(false)
  }
})

import { expect, test } from 'bun:test'
import { CONTAINER_TOOL_NAME, DESCRIPTION } from 'src/tools/ContainerTool/prompt.js'

/**
 * The tool is deferred, so this string costs nothing until `ToolSearch` pulls
 * it. But once pulled it stays in context for the rest of the session, so the
 * op surface being wide is only affordable while the prose stays thin.
 *
 * Budget: ~600 tokens. English prose with this much punctuation and inline
 * code runs a shade over 4 chars/token, so 600 tokens ≈ 2600 chars. That is
 * the number asserted; a description that outgrows it is a product decision,
 * not a formatting accident.
 */
const MAX_DESCRIPTION_CHARS = 2600

/**
 * The real union lives in `src/tools/ContainerTool/types.ts`. It is duplicated
 * here as a literal rather than imported so this test pins the two against each
 * other from the outside: if an op is added to the enum and nowhere else, the
 * model never learns it exists, and nothing else in the build would notice.
 * The two lists MUST agree.
 */
const OPS = [
  // Read
  'ps',
  'inspect',
  'logs',
  'stats',
  'top',
  'port',
  'images',
  'df',
  'config',
  'events',
  // Lifecycle
  'up',
  'down',
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'pull',
  'push',
  // Images
  'build',
  'tag',
  'history',
  // Interact
  'exec',
  'run',
  'cp',
  // Wait
  'wait',
  // Destructive
  'rm',
  'rmi',
  'prune',
] as const

test('the description stays inside its per-session budget', () => {
  expect(DESCRIPTION.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS)
})

test('every op is named in the description', () => {
  // Backtick-delimited, so `rm` does not match inside `rmi` and `run` does not
  // match inside "running".
  const missing = OPS.filter(op => !DESCRIPTION.includes(`\`${op}\``))
  expect(missing).toEqual([])
})

test('it states the scope rule the model gets wrong without it', () => {
  // Without this the model reads an empty `ps` as "the container is not
  // running" when the container is merely unlabelled.
  expect(DESCRIPTION).toContain('working_dir')
  expect(DESCRIPTION).toContain('docker run')
  expect(DESCRIPTION).toContain('invisible')
})

test('it states what wait is for, and how it fails', () => {
  expect(DESCRIPTION).toContain('sleep')
  expect(DESCRIPTION).toContain('no healthcheck')
  expect(DESCRIPTION).toContain('fails fast')
})

test('it states the three build behaviours that differ from a shell-out', () => {
  expect(DESCRIPTION).toContain('cached/rebuilt')
  expect(DESCRIPTION).toContain('nothing rebuilt')
  expect(DESCRIPTION).toContain("failing step's own output")
  expect(DESCRIPTION).toContain('background: true')
})

test('it states that logs are extracted, not tailed', () => {
  expect(DESCRIPTION).toContain('stack traces kept whole')
  expect(DESCRIPTION).toContain('since')
})

test('it states the permission model and the destructive ops', () => {
  expect(DESCRIPTION).toContain('permission-checked')
  expect(DESCRIPTION).toContain('volumes: true')
  expect(DESCRIPTION).toContain('always prompt')
})

test('it states that a failure is not summarized', () => {
  expect(DESCRIPTION).toContain('one-line diagnosis')
  expect(DESCRIPTION).toContain('never as a summary')
})

test('the tool name is the one the description is written for', () => {
  expect(CONTAINER_TOOL_NAME).toBe('Container')
})

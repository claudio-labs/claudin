import { beforeAll, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { checkContainerPermission } from 'src/tools/ContainerTool/permissions.js'

beforeAll(() => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
})

function contextWith(rules: {
  allow?: string[]
  deny?: string[]
}): ToolUseContext {
  const base = getEmptyToolPermissionContext()
  const toolPermissionContext: ToolPermissionContext = {
    ...base,
    ...(rules.allow ? { alwaysAllowRules: { cliArg: rules.allow } } : {}),
    ...(rules.deny ? { alwaysDenyRules: { cliArg: rules.deny } } : {}),
  }
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    getAppState() {
      return { toolPermissionContext }
    },
  } as never
}

test('an existing Bash allow rule covers the equivalent Container op', async () => {
  // The whole point of delegating: a user who allowed `docker ps` in Bash does
  // not have to learn a second rule namespace.
  const result = await checkContainerPermission(
    { op: 'ps' },
    contextWith({ allow: ['Bash(docker ps:*)'] }),
  )
  expect(result.behavior).toBe('allow')
})

test('an existing Bash deny rule blocks the equivalent Container op', async () => {
  const result = await checkContainerPermission(
    { op: 'down', composeFile: 'docker-compose.dev.yml' },
    contextWith({ deny: ['Bash(docker compose:*)'] }),
  )
  expect(result.behavior).toBe('deny')
})

test('on allow it echoes the Container input, never the synthesized Bash one', async () => {
  // bashToolHasPermission returns `updatedInput: { command }` and the harness
  // applies updatedInput verbatim. Passing it through would replace `op` with a
  // field the schema does not have — the bug that made apply_patch dead on
  // arrival in auto/bypass mode.
  const input = { op: 'ps' } as const
  const result = await checkContainerPermission(
    input,
    contextWith({ allow: ['Bash(docker ps:*)'] }),
  )
  expect(result.behavior).toBe('allow')
  if (result.behavior === 'allow') {
    expect(result.updatedInput).toBe(input)
    expect(result.updatedInput).not.toHaveProperty('command')
  }
})

test('prune is never auto-allowed, even with a matching allow rule', async () => {
  // It deletes data no checkout brings back, so an always-allow rule must not
  // be able to wave it through.
  const result = await checkContainerPermission(
    { op: 'prune', target: 'image' },
    contextWith({ allow: ['Bash(docker image prune:*)', 'Bash(docker:*)'] }),
  )
  expect(result.behavior).toBe('ask')
})

test('rm and rmi are never auto-allowed either', async () => {
  const rm = await checkContainerPermission(
    { op: 'rm', service: 'legendarr-1' },
    contextWith({ allow: ['Bash(docker:*)'] }),
  )
  expect(rm.behavior).toBe('ask')

  const rmi = await checkContainerPermission(
    { op: 'rmi', service: 'legendarr:latest' },
    contextWith({ allow: ['Bash(docker:*)'] }),
  )
  expect(rmi.behavior).toBe('ask')
})

test('down --volumes asks, plain down does not', async () => {
  // The flag is what makes it destructive, not the op.
  const plain = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml' },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(plain.behavior).toBe('allow')

  const withVolumes = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml', volumes: true },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(withVolumes.behavior).toBe('ask')
})

test('a deny on a destructive op still wins over the forced ask', async () => {
  const result = await checkContainerPermission(
    { op: 'prune' },
    contextWith({ deny: ['Bash(docker image prune:*)'] }),
  )
  expect(result.behavior).toBe('deny')
})

test('an unbuildable input is denied before anything runs', async () => {
  // `exec` with no command cannot be turned into a command string, so there is
  // nothing to check — and nothing should run.
  const result = await checkContainerPermission(
    { op: 'exec', service: 'x' },
    contextWith({ allow: ['Bash(docker:*)'] }),
  )
  expect(result.behavior).toBe('deny')
})

test('an argument containing a shell operator is quoted before the check', async () => {
  // The permission pipeline parses the string with tree-sitter. An unquoted
  // `;` would read as a second command and change which rule applies.
  const result = await checkContainerPermission(
    { op: 'exec', service: 'x', command: ['sh', '-c', 'echo hi; echo bye'] },
    contextWith({ allow: ['Bash(docker exec:*)'] }),
  )
  expect(result.behavior).toBe('allow')
})

test('a data-deleting flag smuggled through `args` still reaches the dialog', async () => {
  // The gate reads the BUILT argv, not the input fields. `args` is appended
  // verbatim, so each of these is byte-for-byte a command that deletes data —
  // and each used to be auto-allowed by an ordinary `docker compose` rule.
  const smuggledVolumes = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml', args: ['-v'] },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(smuggledVolumes.behavior).toBe('ask')

  const smuggledImages = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml', args: ['--rmi', 'all'] },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(smuggledImages.behavior).toBe('ask')

  const renewedAnonVolumes = await checkContainerPermission(
    { op: 'up', composeFile: 'x.yml', args: ['--renew-anon-volumes'] },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(renewedAnonVolumes.behavior).toBe('ask')
})

test('a short cluster and an =value form are read as the flags they carry', async () => {
  const cluster = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml', args: ['-tv'] },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(cluster.behavior).toBe('ask')

  const equals = await checkContainerPermission(
    { op: 'down', composeFile: 'x.yml', args: ['--rmi=all'] },
    contextWith({ allow: ['Bash(docker compose:*)'] }),
  )
  expect(equals.behavior).toBe('ask')
})

test('the same letter on an op where it is harmless still auto-allows', async () => {
  // `-v` is a bind mount on `run`, not a volume wipe. The table is keyed by op
  // precisely so this does not turn every mount into a dialog.
  const result = await checkContainerPermission(
    { op: 'run', service: 'api', args: ['-v', '/tmp:/tmp'], command: ['ls'] },
    contextWith({ allow: ['Bash(docker run:*)'] }),
  )
  expect(result.behavior).toBe('allow')
})

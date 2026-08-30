import { describe, expect, test } from 'bun:test'
import { getContainerTransitionAttachments } from 'src/agent/attachments/lifecycle.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { ContainerInfo } from 'src/containers/types.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type TaskMap = Record<string, unknown>

/**
 * A context whose setAppState actually mutates, so the signature write-back is
 * observable. That write is the whole cost guarantee — without it every turn
 * would re-report the same transition.
 */
function makeContext(tasks: TaskMap): {
  ctx: ToolUseContext
  /** Live lookup. The producer's write-back REPLACES the tasks map, so holding
   * the initial object would read a stale copy and pass regardless. */
  taskAt: (id: string) => ContainerTaskState
} {
  const state: { tasks: TaskMap } = { tasks }
  const ctx = {
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      const next = updater(state)
      state.tasks = next.tasks
    },
    readFileState: new Map(),
  } as unknown as ToolUseContext
  return { ctx, taskAt: id => state.tasks[id] as ContainerTaskState }
}

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    name: 'legendarr-legendarr-1',
    image: 'legendarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [],
    project: 'legendarr',
    service: 'legendarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

function task(
  id: string,
  info: ContainerInfo,
  over: Partial<ContainerTaskState> = {},
): ContainerTaskState {
  return {
    id,
    type: 'container',
    status: 'running',
    description: info.service ?? info.name,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    container: info,
    startedByUs: false,
    restartCount: 0,
    lastNotifiedSignature: null,
    diedAt: null,
    ...over,
  }
}

function transitionsOf(out: Attachment[]) {
  const first = out[0]
  if (!first || first.type !== 'container_transition') return null
  return first
}

/** The literal text the model receives. */
function renderedText(attachment: Attachment): string {
  const messages = normalizeAttachmentForAPI(attachment)
  return messages
    .map(m =>
      typeof m.message.content === 'string'
        ? m.message.content
        : m.message.content
            .map(block => ('text' in block ? block.text : ''))
            .join(''),
    )
    .join('\n')
}

describe('getContainerTransitionAttachments', () => {
  test('three healthy containers on first sight produce nothing, but are seeded', async () => {
    // Opening a session on a running stack must not announce it. If this ever
    // emits, every session with docker running pays for a paragraph it did not
    // ask for.
    const { ctx, taskAt } = makeContext({
      c1: task('c1', container({ id: 'c1', name: 'legendarr-legendarr-1' })),
      c2: task(
        'c2',
        container({
          id: 'c2',
          name: 'legendarr-sonarr-1',
          service: 'sonarr',
          health: 'healthy',
        }),
      ),
      c3: task(
        'c3',
        container({ id: 'c3', name: 'legendarr-db-1', service: 'db' }),
      ),
    })

    expect(await getContainerTransitionAttachments(ctx)).toEqual([])

    for (const id of ['c1', 'c2', 'c3']) {
      expect(taskAt(id).lastNotifiedSignature).not.toBeNull()
    }
  })

  test('a healthy → unhealthy transition produces exactly one line', async () => {
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({ health: 'unhealthy', status: 'Up 2 hours (unhealthy)' }),
        { lastNotifiedSignature: 'running/healthy/' },
      ),
    })

    const out = await getContainerTransitionAttachments(ctx)
    const attachment = transitionsOf(out)
    expect(attachment).not.toBeNull()
    expect(attachment?.transitions).toHaveLength(1)
    expect(attachment?.transitions[0]?.from).toBe('healthy')
    expect(attachment?.transitions[0]?.to).toBe('unhealthy')
    expect(attachment?.transitions[0]?.name).toBe('legendarr-1')
    expect(attachment?.transitions[0]?.issue).toContain('unhealthy')
  })

  test('the same state on a later turn produces nothing — the cost guarantee', async () => {
    const { ctx, taskAt } = makeContext({
      c1: task(
        'c1',
        container({ health: 'unhealthy', status: 'Up 2 hours (unhealthy)' }),
        { lastNotifiedSignature: 'running/healthy/' },
      ),
    })

    expect(await getContainerTransitionAttachments(ctx)).toHaveLength(1)
    // The write-back happened, so the second call sees nothing new.
    expect(taskAt('c1').lastNotifiedSignature).toBe('running/unhealthy/')
    expect(await getContainerTransitionAttachments(ctx)).toEqual([])
    expect(await getContainerTransitionAttachments(ctx)).toEqual([])
  })

  test('a first sighting that is already unhealthy IS reported', async () => {
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({ health: 'unhealthy', status: 'Up 2 hours (unhealthy)' }),
      ),
    })

    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    expect(attachment?.transitions).toHaveLength(1)
    // Nothing to compare against, so no arrow — but it is still news.
    expect(attachment?.transitions[0]?.from).toBeNull()
    expect(attachment?.transitions[0]?.to).toBe('unhealthy')
  })

  test('a first sighting that is already exited IS reported', async () => {
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({
          state: 'exited',
          status: 'Exited (137) 3 minutes ago',
          exitCode: 137,
        }),
      ),
    })

    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    expect(attachment?.transitions).toHaveLength(1)
    expect(attachment?.transitions[0]?.to).toBe('exited (137)')
    expect(attachment?.transitions[0]?.issue).toContain('SIGKILL')
  })

  test('a clean exit 0 on first sight is not news', async () => {
    // A batch container that finished did its job.
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({
          state: 'exited',
          status: 'Exited (0) 3 minutes ago',
          exitCode: 0,
        }),
      ),
    })
    expect(await getContainerTransitionAttachments(ctx)).toEqual([])
  })

  test('the payload carries nothing from a clock', async () => {
    // Docker's Status string moves every turn ("Up 2 hours" → "Up 3 hours").
    // If any of it leaked into the attachment, the rendered bytes would change
    // on an idle turn and rebill the whole cached prefix.
    const build = (status: string) =>
      makeContext({
        c1: task('c1', container({ health: 'unhealthy', status }), {
          lastNotifiedSignature: 'running/healthy/',
        }),
      })

    const early = transitionsOf(
      await getContainerTransitionAttachments(build('Up 2 hours (unhealthy)').ctx),
    )
    const later = transitionsOf(
      await getContainerTransitionAttachments(build('Up 9 days (unhealthy)').ctx),
    )

    expect(early).not.toBeNull()
    expect(later).not.toBeNull()
    expect(JSON.stringify(early)).toBe(JSON.stringify(later))
    expect(renderedText(early as Attachment)).toBe(
      renderedText(later as Attachment),
    )
  })

  test('a ten-container burst is collapsed, and every signature is still consumed', async () => {
    const tasks: TaskMap = {}
    for (let i = 0; i < 10; i++) {
      const id = `c${i}`
      tasks[id] = task(
        id,
        container({
          id,
          name: `legendarr-worker-${i}`,
          service: 'worker',
          state: 'exited',
          status: 'Exited (1) 1 second ago',
          exitCode: 1,
        }),
        { lastNotifiedSignature: 'running/none/' },
      )
    }
    const { ctx, taskAt } = makeContext(tasks)

    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    expect(attachment?.transitions.length).toBeLessThanOrEqual(3)
    expect(attachment?.elidedCount).toBe(
      10 - (attachment?.transitions.length ?? 0),
    )

    // Elided is not deferred: an elided container must not re-fire next turn.
    for (let i = 0; i < 10; i++) {
      expect(taskAt(`c${i}`).lastNotifiedSignature).toBe('exited/none/1')
    }
    expect(await getContainerTransitionAttachments(ctx)).toEqual([])
  })

  test('a problem outranks a plain change when the cap bites', async () => {
    const tasks: TaskMap = {}
    // Five containers that merely started, plus one that is unhealthy.
    for (let i = 0; i < 5; i++) {
      const id = `ok${i}`
      tasks[id] = task(
        id,
        container({ id, name: `legendarr-ok-${i}`, service: 'ok' }),
        { lastNotifiedSignature: 'created/none/' },
      )
    }
    tasks.bad = task(
      'bad',
      container({
        id: 'bad',
        name: 'legendarr-bad-1',
        service: 'bad',
        health: 'unhealthy',
        status: 'Up 1 minute (unhealthy)',
      }),
      { lastNotifiedSignature: 'running/starting/' },
    )
    const { ctx } = makeContext(tasks)

    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    expect(attachment?.transitions.map(t => t.name)).toContain('bad-1')
  })

  test('ignores non-container tasks', async () => {
    const { ctx } = makeContext({
      b1: { id: 'b1', type: 'local_bash', status: 'running' },
    })
    expect(await getContainerTransitionAttachments(ctx)).toEqual([])
  })

  test('an unparseable stored signature degrades to no arrow, not a wrong one', async () => {
    // A resumed session may carry a signature from an older shape. Guessing at
    // the previous state would put a false "from" in front of the model.
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({ health: 'unhealthy', status: 'Up 2 hours (unhealthy)' }),
        { lastNotifiedSignature: 'nonsense' },
      ),
    })
    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    expect(attachment?.transitions[0]?.from).toBeNull()
    expect(attachment?.transitions[0]?.to).toBe('unhealthy')
  })
})

describe('rendering', () => {
  test('reads as a plain status report with no instruction to conceal it', async () => {
    const { ctx } = makeContext({
      c1: task(
        'c1',
        container({
          state: 'exited',
          status: 'Exited (137) 1 second ago',
          exitCode: 137,
        }),
        { lastNotifiedSignature: 'running/healthy/' },
      ),
    })
    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    const text = renderedText(attachment as Attachment)

    expect(text).toContain('legendarr-1')
    expect(text).toContain('healthy → exited (137)')
    expect(text).toContain('Container')
    // A reminder carrying a gag order reads as prompt injection.
    expect(text.toLowerCase()).not.toContain("don't tell")
    expect(text.toLowerCase()).not.toContain('do not tell')
    expect(text.toLowerCase()).not.toContain('do not mention')
  })

  test('names the elided remainder rather than dropping it silently', async () => {
    const tasks: TaskMap = {}
    for (let i = 0; i < 6; i++) {
      const id = `c${i}`
      tasks[id] = task(
        id,
        container({
          id,
          name: `legendarr-w-${i}`,
          service: 'w',
          state: 'exited',
          status: 'Exited (1) 1s ago',
          exitCode: 1,
        }),
        { lastNotifiedSignature: 'running/none/' },
      )
    }
    const { ctx } = makeContext(tasks)
    const attachment = transitionsOf(await getContainerTransitionAttachments(ctx))
    const text = renderedText(attachment as Attachment)
    expect(text).toContain('3 other containers also changed state.')
  })
})

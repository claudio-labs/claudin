import { describe, expect, test } from 'bun:test'
import newSession from 'src/commands/new/index.js'
import {
  newSessionOptions,
  startNewSession,
  type NewSessionDeps,
  type RunningWork,
} from 'src/commands/new/newSession.js'

const IDLE: RunningWork = { turnActive: false, runningAgents: 0 }
const TURN: RunningWork = { turnActive: true, runningAgents: 0 }
const AGENTS: RunningWork = { turnActive: false, runningAgents: 2 }

function harness(work: RunningWork) {
  const calls: string[] = []
  const deps: NewSessionDeps = {
    sessionId: () => 'old',
    running: () => work,
    backgroundTurn: async () => {
      calls.push('backgroundTurn:start')
      await Bun.sleep(5)
      calls.push('backgroundTurn:done')
    },
    stopForegroundWork: keepRunning => {
      calls.push(`stop:${keepRunning ?? false}`)
    },
    clear: async () => {
      calls.push('clear')
    },
    close: id => {
      calls.push(`close:${id}`)
    },
  }
  return { calls, deps }
}

describe('/new', () => {
  test('is asked at once, never queued behind a running turn', () => {
    expect(newSession.immediate).toBe(true)
  })

  test('asks End / Keep when nothing runs, and adds the third answer when something does', () => {
    expect(newSessionOptions(undefined).map(o => o.value)).toEqual(['end', 'keep'])

    const busy = newSessionOptions('the running turn')
    expect(busy.map(o => o.value)).toEqual(['background', 'keep', 'end'])
    for (const option of busy) expect(option.description).toContain('the running turn')
  })

  test('backgrounding hands the turn over BEFORE the conversation is cleared', async () => {
    const { calls, deps } = harness(TURN)
    await startNewSession('background', deps)
    expect(calls).toEqual(['backgroundTurn:start', 'backgroundTurn:done', 'stop:true', 'clear'])
  })

  test('stopping keeps the session open or ends it, and stops the work either way', async () => {
    const kept = harness(TURN)
    await startNewSession('keep', kept.deps)
    expect(kept.calls).toEqual(['stop:false', 'clear'])

    const ended = harness(TURN)
    await startNewSession('end', ended.deps)
    expect(ended.calls).toEqual(['stop:false', 'clear', 'close:old'])
  })

  test('with nothing running only the conversation is cleared, as before', async () => {
    const kept = harness(IDLE)
    await startNewSession('keep', kept.deps)
    expect(kept.calls).toEqual(['clear'])

    const ended = harness(IDLE)
    await startNewSession('end', ended.deps)
    expect(ended.calls).toEqual(['clear', 'close:old'])
  })

  test('a turn that ended while the dialog was open is not backgrounded', async () => {
    const { calls, deps } = harness(IDLE)
    await startNewSession('background', deps)
    expect(calls).toEqual(['clear'])
  })

  test('agents alone are spared without a turn to hand over', async () => {
    const { calls, deps } = harness(AGENTS)
    await startNewSession('background', deps)
    expect(calls).toEqual(['stop:true', 'clear'])
  })
})

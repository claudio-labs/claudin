import { describe, expect, test } from 'bun:test'
import { footerRowAction } from 'src/agent/ui/tasks/footerRowAction.js'
import {
  TASK_TYPES,
  containerInfo,
  taskFixture,
} from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

describe('footerRowAction', () => {
  test('every task type answers, so a new one cannot land unadvertised', () => {
    for (const type of TASK_TYPES) {
      expect([null, 'stop', 'disconnect']).toContain(footerRowAction(taskFixture(type)))
    }
  })

  test('a finished task offers nothing', () => {
    for (const type of TASK_TYPES) {
      expect(footerRowAction(taskFixture(type, { status: 'completed' }))).toBeNull()
    }
  })

  test('an MCP server is disconnected, not stopped', () => {
    expect(footerRowAction(taskFixture('mcp_server'))).toBe('disconnect')
  })

  test('an MCP server that is not connected offers nothing', () => {
    // The bug this guards: every one of these keeps `status: 'running'`, so the
    // byline advertised `x` over a row where the key does nothing at all.
    for (const connectionType of ['failed', 'pending', 'disabled', 'needs-auth']) {
      expect(footerRowAction(taskFixture('mcp_server', { connectionType }))).toBeNull()
    }
  })

  test('a container past its grace period offers nothing', () => {
    // Same shape as the MCP row: the task status stays `running` after the
    // container itself has exited.
    expect(
      footerRowAction(
        taskFixture('container', {
          container: containerInfo({ state: 'exited', exitCode: 0 }),
        }),
      ),
    ).toBeNull()
    expect(footerRowAction(taskFixture('container'))).toBe('stop')
  })

  test('a running shell is still just stopped', () => {
    expect(footerRowAction(taskFixture('local_bash'))).toBe('stop')
    expect(footerRowAction(taskFixture('local_agent'))).toBe('stop')
  })
})

/**
 * Characterization of the task registry: the lookup `stopTask` uses to find
 * the kill implementation for a task type.
 *
 * The descriptors are compared by identity with the bindings this file
 * imports, and the lookup against the list itself. Both hold whether or not
 * another suite of the run (taskActions.test.ts) has stubbed a descriptor.
 */
import { describe, expect, test } from 'bun:test'
import { getAllTasks, getTaskByType } from 'src/agent/tasks.js'
import { DreamTask } from 'src/agent/tasks/DreamTask/DreamTask.js'
import { LocalAgentTask } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'

const LOOKED_UP = ['local_bash', 'local_agent', 'dream', 'monitor_mcp', 'container', 'mcp_server', 'local_workflow', 'in_process_teammate', 'no_such_type']

describe('task registry', () => {
  test('the list holds the shell, agent and dream implementations, each once', () => {
    const all = getAllTasks()
    for (const impl of [LocalShellTask, LocalAgentTask, DreamTask]) {
      expect(all.filter(entry => entry === impl)).toHaveLength(1)
    }
    for (const entry of all) expect(typeof entry.kill).toBe('function')
  })

  test('the shell comes first, ahead of the agent', () => {
    const all = getAllTasks()
    expect(all[0]).toBe(LocalShellTask)
    expect(all.indexOf(LocalAgentTask)).toBe(1)
    expect(all.indexOf(DreamTask)).toBeGreaterThan(1)
  })

  test('a lookup returns the first listed implementation of that type, or undefined', () => {
    const all = getAllTasks()
    for (const type of LOOKED_UP) {
      expect(getTaskByType(type as never), type).toBe(all.find(entry => entry.type === type))
    }
  })

  test('types with no registered kill implementation are not found', () => {
    for (const type of ['container', 'mcp_server', 'local_workflow', 'in_process_teammate', 'no_such_type']) {
      expect(getTaskByType(type as never), type).toBeUndefined()
    }
  })

  test('the monitor task is absent while its build flag is off', () => {
    expect(getAllTasks().some(entry => entry.type === 'monitor_mcp')).toBe(false)
    expect(getTaskByType('monitor_mcp' as never)).toBeUndefined()
  })

  test('each call builds a new list', () => {
    const first = getAllTasks()
    expect(getAllTasks()).not.toBe(first)
    first.length = 0
    expect(getAllTasks().length).toBeGreaterThan(0)
  })
})

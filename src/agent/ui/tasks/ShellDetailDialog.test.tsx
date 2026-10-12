import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { ShellOutputContent } from 'src/agent/ui/tasks/ShellDetailDialog.js'
import { renderToAnsiString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

type TaskOutput = { content: string; bytesTotal: number }

/**
 * A promise React's `use()` reads synchronously. A plain resolved promise
 * still suspends once, and the static renderer only keeps the first frame.
 */
function settled(value: TaskOutput): Promise<TaskOutput> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value })
}

const savedLevel = chalk.level
beforeAll(() => {
  chalk.level = 3
})
afterAll(() => {
  chalk.level = savedLevel
})

describe('ShellDetailDialog output', () => {
  test('colors the levels in the tail it shows', async () => {
    const content = 'api-1  | INFO ready\napi-1  | ERROR boom\n'
    const out = await renderToAnsiString(
      <AppStateProvider>
        <ShellOutputContent outputPromise={settled({ content, bytesTotal: content.length })} columns={80} />
      </AppStateProvider>,
    )
    expect(out).toContain('ready')
    expect(out).toContain('Showing 2 lines')
    // dark's `error` is rgb(255,107,128), and the message beside it is plain.
    const at = out.indexOf('ERROR')
    expect(at).toBeGreaterThan(-1)
    expect(out.slice(Math.max(0, at - 30), at)).toContain('38;2;255;107;128')
    expect(out).toContain('ERROR\x1b[39m boom')
  })

  test('two services that hash alike keep different colors across the block', async () => {
    // api-1 and worker-1 land on the same palette slot when colored one line at a time.
    const content = 'api-1     | INFO a\nworker-1  | INFO b\n'
    const out = await renderToAnsiString(
      <AppStateProvider>
        <ShellOutputContent outputPromise={settled({ content, bytesTotal: content.length })} columns={80} />
      </AppStateProvider>,
    )
    const colorBefore = (name: string) => {
      const at = out.indexOf(name)
      return /\x1b\[([\d;]+)m$/.exec(out.slice(0, at))?.[1]
    }
    expect(colorBefore('api-1')).toBeDefined()
    expect(colorBefore('api-1')).not.toBe(colorBefore('worker-1'))
  })
})

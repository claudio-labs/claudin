import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'path'

import { findWatchedLocations } from 'src/skills/changeDetection/watchedLocations.js'

const configHome = resolve('/home/me/.claudin')
const project = resolve('/work/project')
const extra = resolve('/work/extra')

function existing(...paths: string[]): (path: string) => Promise<boolean> {
  const present = new Set(paths)
  return async path => present.has(path)
}

describe('findWatchedLocations', () => {
  test('the user and project skills and commands, and only the skills of an additional directory', async () => {
    const all = [
      join(configHome, 'skills'),
      join(configHome, 'commands'),
      join(project, '.claudin', 'skills'),
      join(project, '.claudin', 'commands'),
      join(extra, '.claudin', 'skills'),
      join(extra, '.claudin', 'commands'),
    ]
    const locations = await findWatchedLocations({
      configHome,
      cwd: project,
      additionalDirectories: [extra],
      exists: existing(...all),
    })
    expect(locations).toEqual(all.slice(0, 5))
  })

  test('only the ones that exist, each once, with relative directories resolved against the cwd', async () => {
    const locations = await findWatchedLocations({
      configHome,
      cwd: project,
      additionalDirectories: ['.', '../extra'],
      exists: existing(join(project, '.claudin', 'skills'), join(extra, '.claudin', 'skills')),
    })
    expect(locations).toEqual([join(project, '.claudin', 'skills'), join(extra, '.claudin', 'skills')])
  })

  test('none, when nothing exists', async () => {
    const locations = await findWatchedLocations({
      configHome,
      cwd: project,
      additionalDirectories: [extra],
      exists: existing(),
    })
    expect(locations).toEqual([])
  })
})

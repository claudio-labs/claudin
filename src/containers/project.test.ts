import { describe, expect, test } from 'bun:test'
import {
  defaultProjectName,
  filterToProject,
  projectsIn,
} from 'src/containers/project.js'
import type { ContainerInfo } from 'src/containers/types.js'

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
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

describe('defaultProjectName', () => {
  test('mirrors compose: basename, lowercased, punctuation dropped', () => {
    expect(defaultProjectName('/home/dev/projects/Legendarr')).toBe('legendarr')
    expect(defaultProjectName('/home/dev/projects/my.app')).toBe('myapp')
    expect(defaultProjectName('/home/dev/projects/_leading')).toBe('leading')
  })

  test('a trailing separator does not blank the name', () => {
    expect(defaultProjectName('/home/dev/projects/legendarr/')).toBe('legendarr')
  })
})

describe('filterToProject', () => {
  test('matches the stack rooted at cwd', () => {
    const out = filterToProject([container()], '/home/dev/projects/legendarr')
    expect(out).toHaveLength(1)
  })

  test('still matches from a subdirectory of the project', () => {
    const out = filterToProject(
      [container()],
      '/home/dev/projects/legendarr/src/web',
    )
    expect(out).toHaveLength(1)
  })

  test('a sibling directory with a shared prefix does not match', () => {
    const out = filterToProject(
      [container()],
      '/home/dev/projects/legendarr-other',
    )
    expect(out).toEqual([])
  })

  test('another project on the same machine is excluded', () => {
    const out = filterToProject(
      [
        container(),
        container({
          id: 'beef',
          name: 'plex',
          project: 'media',
          service: 'plex',
          workingDir: '/home/dev/projects/media',
        }),
      ],
      '/home/dev/projects/legendarr',
    )
    expect(out.map(c => c.id)).toEqual(['c0ffee'])
  })

  test('no match returns empty, never the unfiltered list', () => {
    expect(filterToProject([container()], '/home/dev/projects/claudin')).toEqual(
      [],
    )
  })

  test('a docker run container without compose labels is never matched', () => {
    const bare = container({
      id: 'bare',
      project: null,
      service: null,
      workingDir: null,
    })
    expect(filterToProject([bare], '/home/dev/projects/legendarr')).toEqual([])
  })

  test('falls back to the project name when working_dir is absent', () => {
    const old = container({ workingDir: null, project: 'legendarr' })
    const out = filterToProject([old], '/home/dev/projects/legendarr')
    expect(out).toHaveLength(1)
  })

  test('the working_dir match wins over the name fallback', () => {
    const labelled = container({ id: 'labelled' })
    const unlabelled = container({
      id: 'unlabelled',
      workingDir: null,
      project: 'legendarr',
    })
    const out = filterToProject(
      [labelled, unlabelled],
      '/home/dev/projects/legendarr',
    )
    expect(out.map(c => c.id)).toEqual(['labelled'])
  })

  test('two compose projects sharing a working dir both match', () => {
    const dev = container({ id: 'dev', project: 'legendarr' })
    const test_ = container({ id: 'test', project: 'legendarr-test' })
    const out = filterToProject([dev, test_], '/home/dev/projects/legendarr')
    expect(projectsIn(out)).toEqual(['legendarr', 'legendarr-test'])
  })
})

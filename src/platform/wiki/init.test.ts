import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeWiki } from 'src/platform/wiki/init.js'
import { getWikiPaths } from 'src/platform/wiki/paths.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claudin-wiki-init-'))
  tempDirs.push(dir)
  return dir
}

test('initializeWiki creates the expected wiki scaffold', async () => {
  const cwd = await makeProjectDir()
  const result = await initializeWiki(cwd)
  const paths = getWikiPaths(cwd)

  expect(result.alreadyExisted).toBe(false)
  expect(result.createdFiles).toEqual([
    join('.claudin', 'wiki', 'schema.md'),
    join('.claudin', 'wiki', 'index.md'),
    join('.claudin', 'wiki', 'log.md'),
    join('.claudin', 'wiki', 'pages', 'architecture.md'),
  ])
  expect(await readFile(paths.schemaFile, 'utf8')).toContain(
    '# Claudin Wiki Schema',
  )
  expect(await readFile(paths.indexFile, 'utf8')).toContain('Wiki')
  expect(await readFile(paths.logFile, 'utf8')).toContain(
    'Wiki initialized by Claudin',
  )
  expect(await readFile(join(paths.pagesDir, 'architecture.md'), 'utf8')).toContain(
    '# Architecture',
  )
})

test('initializeWiki is idempotent and preserves existing files', async () => {
  const cwd = await makeProjectDir()

  await initializeWiki(cwd)
  const second = await initializeWiki(cwd)

  expect(second.alreadyExisted).toBe(true)
  expect(second.createdFiles).toEqual([])
})

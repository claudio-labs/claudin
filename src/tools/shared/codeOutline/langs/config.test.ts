import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — YAML', () => {
  test('top-level and nested keys with correct depth and line ranges', () => {
    const src = [
      'server:',
      '  port: 8080',
      '  host: localhost',
      'database:',
      '  name: myapp',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.server).toMatchObject({ kind: 'key', depth: 0, startLine: 1 })
    expect(byName.port).toMatchObject({ kind: 'key', depth: 1, startLine: 2 })
    expect(byName.host).toMatchObject({ kind: 'key', depth: 1, startLine: 3 })
    expect(byName.database).toMatchObject({ kind: 'key', depth: 0, startLine: 4 })
    // server section ends at line before database (line 3)
    expect(byName.server.endLine).toBe(3)
    // database section runs to end (line 5)
    expect(byName.database.endLine).toBe(5)
  })

  test('list-item keys are detected', () => {
    const src = [
      'items:',
      '  - name: first',
      '    value: 1',
      '  - name: second',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('items')
    expect(names).toContain('name')
  })

  test('multi-doc separator resets depth', () => {
    const src = [
      'a: 1',
      'b: 2',
      '---',
      'c: 3',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.a.depth).toBe(0)
    expect(byName.c.depth).toBe(0)
  })

  test('block scalars do not produce false keys', () => {
    const src = [
      'script: |',
      '  echo hello',
      '  echo world',
      'next: value',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('script')
    expect(names).toContain('next')
    // echo and world should NOT be detected as keys
    expect(names).not.toContain('echo')
  })

  test('comments and anchors are not keys', () => {
    const src = [
      '# This is a comment',
      'key: &anchor value',
      '  # nested comment',
      '  sub: *alias',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('key')
    expect(names).toContain('sub')
    expect(names).not.toContain('anchor')
  })

  test('empty and degenerate fail open', () => {
    expect(scanSymbols('', 'yaml')).toEqual([])
    expect(scanSymbols('# only comments\n', 'yaml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

describe('scanSymbols — Config (.properties / .env)', () => {
  test('extracts key=value and key:value pairs', () => {
    const src = [
      'server.port=8080',
      'server.host: localhost',
      'debug = true',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName['server.port']).toBeDefined()
    expect(byName['server.host']).toBeDefined()
    expect(byName.debug).toBeDefined()
    expect(syms.every(s => s.kind === 'key')).toBe(true)
  })

  test('env files with export prefix', () => {
    const src = [
      'DATABASE_URL=postgres://localhost',
      'export NODE_ENV=production',
      '# a comment',
      'PORT=3000',
    ].join('\n')
    const syms = scanSymbols(src, 'env')
    const names = syms.map(s => s.name)
    expect(names).toContain('DATABASE_URL')
    expect(names).toContain('NODE_ENV')
    expect(names).toContain('PORT')
  })

  test('comments and blank lines are skipped', () => {
    const src = [
      '# comment line',
      '! also a comment (properties)',
      '',
      'key=value',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('key')
  })

  test('line continuation does not create false keys', () => {
    const src = [
      'multi=value \\',
      '  continued \\',
      '  more',
      'next=ok',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    const names = syms.map(s => s.name)
    expect(names).toContain('multi')
    expect(names).toContain('next')
    expect(names).not.toContain('continued')
    expect(names).not.toContain('more')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'env')).toEqual([])
    expect(scanSymbols('# only comments\n', 'properties')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

describe('scanSymbols — TOML', () => {
  test('tables and array tables are detected', () => {
    const src = [
      '[package]',
      'name = "myapp"',
      '[dependencies]',
      'serde = "1.0"',
      '[[bin]]',
      'name = "myapp"',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    const names = syms.map(s => s.name)
    expect(names).toContain('package')
    expect(names).toContain('dependencies')
    expect(names).toContain('bin')
  })

  test('dotted table names get depth by dot count', () => {
    const src = [
      '[tool.poetry]',
      'name = "x"',
      '[tool.poetry.dependencies]',
      'pytest = "7"',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName['tool.poetry'].depth).toBe(1)
    expect(byName['tool.poetry.dependencies'].depth).toBe(2)
  })

  test('key=value lines are not tables', () => {
    const src = [
      '[section]',
      'key = "value"',
      '# comment',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('section')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'toml')).toEqual([])
    expect(scanSymbols('# only comments\n', 'toml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

describe('scanSymbols — Dockerfile', () => {
  test('instructions are detected with correct depth', () => {
    const src = [
      'FROM node:18 AS builder',
      'RUN npm install',
      'COPY . .',
      'CMD ["node", "server.js"]',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.builder).toMatchObject({ kind: 'key', depth: 0, startLine: 1 })
    expect(byName.RUN).toMatchObject({ kind: 'key', depth: 1, startLine: 2 })
    expect(byName.COPY).toMatchObject({ kind: 'key', depth: 1, startLine: 3 })
    expect(byName.CMD).toMatchObject({ kind: 'key', depth: 1, startLine: 4 })
  })

  test('multi-stage builds reset depth', () => {
    const src = [
      'FROM node:18 AS build',
      'RUN npm run build',
      'FROM nginx:alpine',
      'COPY --from=build /dist /usr/share/nginx/html',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const froms = syms.filter(s => s.depth === 0)
    expect(froms).toHaveLength(2)
    expect(froms[0]!.name).toBe('build')
    // Second FROM without AS gets a generated name
    expect(froms[1]!.name).toMatch(/^FROM_/)
  })

  test('comments are skipped', () => {
    const src = [
      '# Build stage',
      'FROM node:18',
      '# Install deps',
      'RUN npm install',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    expect(syms).toHaveLength(2)
  })
  test('continuation across a comment line does not get stuck', () => {
    // Docker skips comment lines inside a `\`-continuation and keeps it open:
    // `COPY . .` here is continuation text of the RUN, not an instruction.
    // The continuation must then end there (the line has no trailing `\`) so
    // the NEXT real instruction (CMD) is not swallowed too.
    const src = [
      'FROM node:18 AS builder',
      'RUN echo hello \\',
      '# a comment inside the continuation',
      'COPY . .',
      'CMD ["node", "server.js"]',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.builder).toBeDefined()
    expect(byName.RUN).toBeDefined()
    expect(byName.COPY).toBeUndefined()
    expect(byName.CMD).toMatchObject({ kind: 'key', startLine: 5 })
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'dockerfile')).toEqual([])
    expect(scanSymbols('# only comments\n', 'dockerfile')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

describe('scanSymbols — Makefile', () => {
  test('targets and variables are detected', () => {
    const src = [
      'CC = gcc',
      'CFLAGS = -Wall -O2',
      'build: main.o util.o',
      '\t$(CC) -o app main.o util.o',
      'clean:',
      '\trm -f *.o app',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.CC).toMatchObject({ kind: 'const' })
    expect(byName.CFLAGS).toMatchObject({ kind: 'const' })
    expect(byName.build).toMatchObject({ kind: 'function', startLine: 3 })
    expect(byName.clean).toMatchObject({ kind: 'function' })
  })

  test('target body extends through recipe lines', () => {
    const src = [
      'build: deps',
      '\tcommand1',
      '\tcommand2',
      'other:',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    // build endLine should include recipe lines (line 3)
    expect(byName.build.endLine).toBe(3)
  })

  test('pattern rules and .PHONY are detected', () => {
    const src = [
      '.PHONY: clean build',
      '%.o: %.c',
      '\t$(CC) -c $< -o $@',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const names = syms.map(s => s.name)
    expect(names).toContain('.PHONY')
    expect(names).toContain('%.o')
  })

  test('tab-indented recipe lines and includes are not targets', () => {
    const src = [
      'include common.mk',
      '\tnot a target',
      'build:',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const names = syms.map(s => s.name)
    expect(names).toContain('build')
    expect(names).not.toContain('include')
    expect(names).not.toContain('not')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'makefile')).toEqual([])
    expect(scanSymbols('# only comments\n', 'makefile')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

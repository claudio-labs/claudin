import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { detectOutlineLang, detectOutlineLangFromPath, scanSymbols } from '../shared/codeOutline/scanSymbols.js'
import type { SymbolKind } from '../shared/codeOutline/scanSymbols.js'

// ---------------------------------------------------------------------------
// Smoke: every NEW language from the plan produces ≥1 symbol on a realistic
// file, end-to-end (file read → detectOutlineLang → scanSymbols). This
// complements the in-memory scanSymbols.test.ts cases by exercising the full
// pipeline that the Read/Grep tools use.
// ---------------------------------------------------------------------------

describe('outline — every plan language yields symbols on a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outline-smoke-'))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const cases: Array<{ ext: string; content: string; expectName: string; expectKind: SymbolKind }> = [
    {
      ext: 'c',
      content: [
        'struct Point { int x; int y; };',
        'int add(int a, int b) { return a + b; }',
      ].join('\n'),
      expectName: 'add',
      expectKind: 'function',
    },
    {
      ext: 'cpp',
      content: [
        'class Renderer {',
        'public:',
        '  void draw();',
        '};',
        'void Renderer::draw() { /* paint */ }',
      ].join('\n'),
      expectName: 'Renderer',
      expectKind: 'class',
    },
    {
      ext: 'php',
      content: [
        '<?php',
        'function greet($name) {',
        '  return "hi $name";',
        '}',
      ].join('\n'),
      expectName: 'greet',
      expectKind: 'function',
    },
    {
      ext: 'swift',
      content: [
        'struct Vec {',
        '  let x: Int',
        '  let y: Int',
        '}',
        'protocol Drawable { func draw() }',
      ].join('\n'),
      expectName: 'Vec',
      expectKind: 'struct',
    },
    {
      ext: 'scala',
      content: [
        'object App {',
        '  def main(args: Array[String]): Unit = println("hi")',
        '}',
      ].join('\n'),
      expectName: 'main',
      expectKind: 'method',
    },
    {
      ext: 'rb',
      content: [
        'class Worker',
        '  def process',
        '    puts "ok"',
        '  end',
        'end',
      ].join('\n'),
      expectName: 'process',
      expectKind: 'method',
    },
    {
      ext: 'lua',
      content: [
        'function process(item)',
        '  print(item)',
        'end',
        'local function helper() return 1 end',
      ].join('\n'),
      expectName: 'process',
      expectKind: 'function',
    },
    {
      ext: 'sh',
      content: [
        '#!/usr/bin/env bash',
        'build() {',
        '  echo "building"',
        '}',
      ].join('\n'),
      expectName: 'build',
      expectKind: 'function',
    },
    {
      ext: 'sql',
      content: [
        'CREATE TABLE users (',
        '  id INTEGER PRIMARY KEY,',
        '  name TEXT NOT NULL',
        ');',
        'CREATE INDEX idx_users_name ON users(name);',
      ].join('\n'),
      expectName: 'users',
      expectKind: 'table',
    },
    {
      ext: 'css',
      content: [
        '.btn { color: red; }',
        '@media (max-width: 600px) {',
        '  .btn { font-size: 12px; }',
        '}',
      ].join('\n'),
      expectName: '.btn',
      expectKind: 'selector',
    },
    {
      ext: 'html',
      content: [
        '<!DOCTYPE html>',
        '<html>',
        '  <body>',
        '    <h1>Title</h1>',
        '    <div id="main">x</div>',
        '  </body>',
        '</html>',
      ].join('\n'),
      expectName: 'Title',
      expectKind: 'heading',
    },
  ]

  for (const c of cases) {
    test(`${c.ext} → detects ${c.expectName} (${c.expectKind})`, () => {
      const path = join(dir, `sample.${c.ext}`)
      writeFileSync(path, c.content, 'utf8')
      const lang = detectOutlineLang(c.ext)
      expect(lang).not.toBeNull()
      const source = readFileSync(path, 'utf8')
      const syms = scanSymbols(source, lang!)
      expect(syms.length).toBeGreaterThan(0)
      const byName = Object.fromEntries(syms.map(s => [s.name, s]))
      expect(byName[c.expectName]).toBeDefined()
      expect(byName[c.expectName]!.kind).toBe(c.expectKind)
    })
  }

  test('unsupported extension (.txt) returns null from detectOutlineLang', () => {
    expect(detectOutlineLang('txt')).toBeNull()
  })

  // --- New config / markup / build formats ---

  const newCases: Array<{ ext: string; content: string; expectName: string; expectKind: SymbolKind }> = [
    {
      ext: 'yaml',
      content: [
        'server:',
        '  port: 8080',
        '  host: localhost',
        'database:',
        '  name: myapp',
      ].join('\n'),
      expectName: 'server',
      expectKind: 'key',
    },
    {
      ext: 'xml',
      content: [
        '<?xml version="1.0"?>',
        '<beans>',
        '  <bean id="dataSource" class="DataSource"/>',
        '</beans>',
      ].join('\n'),
      expectName: 'dataSource',
      expectKind: 'element',
    },
    {
      ext: 'properties',
      content: [
        'server.port=8080',
        'server.host=localhost',
        '# comment',
      ].join('\n'),
      expectName: 'server.port',
      expectKind: 'key',
    },
    {
      ext: 'env',
      content: [
        'DATABASE_URL=postgres://localhost',
        '# comment',
        'PORT=3000',
      ].join('\n'),
      expectName: 'DATABASE_URL',
      expectKind: 'key',
    },
    {
      ext: 'toml',
      content: [
        '[package]',
        'name = "myapp"',
        '[dependencies]',
        'serde = "1.0"',
      ].join('\n'),
      expectName: 'package',
      expectKind: 'key',
    },
    {
      ext: 'graphql',
      content: [
        'type User {',
        '  id: ID!',
        '  name: String!',
        '}',
      ].join('\n'),
      expectName: 'User',
      expectKind: 'class',
    },
    {
      ext: 'tf',
      content: [
        'resource "aws_instance" "web" {',
        '  ami = "ami-123"',
        '}',
      ].join('\n'),
      expectName: 'aws_instance.web',
      expectKind: 'class',
    },
  ]

  for (const c of newCases) {
    test(`${c.ext} → detects ${c.expectName} (${c.expectKind})`, () => {
      const path = join(dir, `sample.${c.ext}`)
      writeFileSync(path, c.content, 'utf8')
      const lang = detectOutlineLang(c.ext)
      expect(lang).not.toBeNull()
      const source = readFileSync(path, 'utf8')
      const syms = scanSymbols(source, lang!)
      expect(syms.length).toBeGreaterThan(0)
      const byName = Object.fromEntries(syms.map(s => [s.name, s]))
      expect(byName[c.expectName]).toBeDefined()
      expect(byName[c.expectName]!.kind).toBe(c.expectKind)
    })
  }

  test('Dockerfile (no extension) → detects builder (key)', () => {
    const path = join(dir, 'Dockerfile')
    writeFileSync(path, 'FROM node:18 AS builder\nRUN npm install\n', 'utf8')
    const lang = detectOutlineLangFromPath(path)
    expect(lang).toBe('dockerfile')
    const source = readFileSync(path, 'utf8')
    const syms = scanSymbols(source, 'dockerfile')
    expect(syms.length).toBeGreaterThan(0)
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.builder).toBeDefined()
    expect(byName.builder!.kind).toBe('key')
  })

  test('Makefile (no extension) → detects target (function)', () => {
    const path = join(dir, 'Makefile')
    writeFileSync(path, 'CC = gcc\nbuild:\n\tgcc -o app\n', 'utf8')
    const lang = detectOutlineLangFromPath(path)
    expect(lang).toBe('makefile')
    const source = readFileSync(path, 'utf8')
    const syms = scanSymbols(source, 'makefile')
    expect(syms.length).toBeGreaterThan(0)
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.build).toBeDefined()
    expect(byName.build!.kind).toBe('function')
  })
})

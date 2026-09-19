import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — GraphQL', () => {
  test('type, input, interface, enum, scalar, union definitions', () => {
    const src = [
      'type User {',
      '  id: ID!',
      '  name: String!',
      '}',
      'input UserInput {',
      '  name: String!',
      '}',
      'interface Node {',
      '  id: ID!',
      '}',
      'enum Status { ACTIVE INACTIVE }',
      'scalar DateTime',
      'union Result = User | Error',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.User).toMatchObject({ kind: 'class', depth: 0 })
    expect(byName.UserInput).toMatchObject({ kind: 'record', depth: 0 })
    expect(byName.Node).toMatchObject({ kind: 'interface', depth: 0 })
    expect(byName.Status).toMatchObject({ kind: 'enum', depth: 0 })
    expect(byName.DateTime).toMatchObject({ kind: 'type', depth: 0 })
    expect(byName.Result).toMatchObject({ kind: 'type', depth: 0 })
  })

  test('fields inside types are methods at depth 1', () => {
    const src = [
      'type User {',
      '  id: ID!',
      '  name(prefix: String): String!',
      '  email: String',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.id).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.name).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.email).toMatchObject({ kind: 'method', depth: 1 })
  })

  test('comments and doc strings are masked', () => {
    const src = [
      '# comment',
      '"""doc string"""',
      'type User {',
      '  id: ID!',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const names = syms.map(s => s.name)
    expect(names).toContain('User')
    expect(names).not.toContain('comment')
    expect(names).not.toContain('doc')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'graphql')).toEqual([])
    expect(scanSymbols('# only comments\n', 'graphql')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Terraform / HCL
// ---------------------------------------------------------------------------

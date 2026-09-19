import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — SQL', () => {
  test('CREATE table/view/index/function with dollar-quoted body', () => {
    const src = [
      '-- schema',
      'CREATE TABLE users (',
      '  id INT PRIMARY KEY,',
      '  name TEXT',
      ');',
      '',
      'CREATE OR REPLACE VIEW active_users AS',
      'SELECT * FROM users WHERE active = 1;',
      '',
      'CREATE INDEX idx_name ON users (name);',
      '',
      'CREATE FUNCTION add(a int, b int) RETURNS int AS $body$',
      'BEGIN',
      '  RETURN a + b;',
      'END;',
      '$body$ LANGUAGE plpgsql;',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.users).toMatchObject({
      kind: 'table',
      startLine: 2,
      endLine: 5,
    })
    expect(byName.active_users).toMatchObject({
      kind: 'view',
      startLine: 7,
      endLine: 8,
    })
    expect(byName.idx_name).toMatchObject({ startLine: 10, endLine: 10 })
    // Dollar-quoting masks the inner `;` so the body span is correct.
    expect(byName.add).toMatchObject({
      kind: 'function',
      startLine: 12,
      endLine: 16,
    })
  })

  test('materialized view, trigger, quoted names, and IF NOT EXISTS', () => {
    const src = [
      'CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."stats" AS',
      'SELECT 1;',
      'CREATE TRIGGER audit_ins AFTER INSERT ON users',
      'FOR EACH ROW EXECUTE FUNCTION log_it();',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['public.stats']).toMatchObject({ kind: 'view' })
    expect(byName.audit_ins).toMatchObject({ kind: 'trigger' })
  })

  test('CREATE in comments and strings is ignored', () => {
    const src = [
      "-- CREATE TABLE ghost (id int);",
      "/* CREATE VIEW fake AS SELECT 1; */",
      "INSERT INTO t VALUES ('CREATE TABLE notReal (x int)');",
      'CREATE TABLE live (id int);',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('empty SQL yields no symbols', () => {
    expect(scanSymbols('', 'sql')).toEqual([])
    expect(scanSymbols('SELECT * FROM users;\n', 'sql')).toEqual([])
  })
})

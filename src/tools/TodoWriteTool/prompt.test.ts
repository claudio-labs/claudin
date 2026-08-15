import { describe, expect, test } from 'bun:test'
import { DESCRIPTION, PROMPT } from 'src/tools/TodoWriteTool/prompt.js'

// Baseline: old file byte count (wc -c src/tools/TodoWriteTool/prompt.ts) before
// the poda. PROMPT.length is smaller (excludes import, export declaration,
// backticks, DESCRIPTION block), so savings figures are slightly conservative.
const FILE_BYTES_BEFORE_PODA = 9_527

describe('TodoWriteTool/prompt', () => {
  // 1. Savings measurement — verifies the actual improvement vs baseline
  test('poda removeu pelo menos 3000 chars (≥30% do original)', () => {
    const saved = FILE_BYTES_BEFORE_PODA - PROMPT.length
    expect(saved).toBeGreaterThan(3_000)
  })

  test('PROMPT tem menos de 5500 chars após poda', () => {
    // Trava o teto absoluto — regressão visível se alguém reintroduzir exemplos
    expect(PROMPT.length).toBeLessThan(5_500)
  })

  test('PROMPT tem mais de 2000 chars (guard contra over-trim)', () => {
    // Garante que cortes futuros não removam conteúdo estrutural por acidente
    expect(PROMPT.length).toBeGreaterThan(2_000)
  })

  test('PROMPT é ao menos 35% menor que o baseline', () => {
    expect(PROMPT.length / FILE_BYTES_BEFORE_PODA).toBeLessThan(0.65)
  })

  // 2. Required structural content still present
  test('PROMPT contém a seção Task States', () => {
    expect(PROMPT).toContain('Task States')
  })

  test('PROMPT contém pelo menos um <example>', () => {
    expect(PROMPT).toContain('<example>')
  })

  test('PROMPT contém a lista "When to Use"', () => {
    expect(PROMPT).toContain('When to Use')
  })

  // 3. Removed content must not be present
  test('PROMPT não contém blocos <reasoning>', () => {
    expect(PROMPT).not.toContain('<reasoning>')
  })

  test('PROMPT não contém exemplos de "When NOT to Use"', () => {
    expect(PROMPT).not.toContain('Hello World')      // "print Hello World" example removed
    expect(PROMPT).not.toContain('git status do')    // "what does git status do" example removed
    expect(PROMPT).not.toContain('calculateTotal')   // "add a comment to calculateTotal" example removed
    expect(PROMPT).not.toContain('npm install')      // "run npm install" example removed
  })

  test('PROMPT não contém exemplos redundantes de "When to Use"', () => {
    expect(PROMPT).not.toContain('e-commerce')       // e-commerce feature list example removed
    expect(PROMPT).not.toContain('memoization')      // React perf optimization example removed
  })

  // 4. DESCRIPTION always present and non-empty
  test('DESCRIPTION é uma string não vazia', () => {
    expect(typeof DESCRIPTION).toBe('string')
    expect(DESCRIPTION.length).toBeGreaterThan(0)
  })
})

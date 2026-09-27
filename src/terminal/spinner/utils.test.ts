import { describe, expect, test } from 'bun:test'
import { fitSpinnerMessage } from 'src/terminal/spinner/utils.js'

describe('fitSpinnerMessage', () => {
  test('draws the ellipsis as three dots when the message fits', () => {
    expect(fitSpinnerMessage('Whirlpooling…', 80)).toBe('Whirlpooling...')
  })

  test('cuts a long task name to half the terminal width', () => {
    const fitted = fitSpinnerMessage(
      'Refatorando o parser de configuração do provider para aceitar perfis aninhados…',
      80,
    )
    expect(fitted).toBe('Refatorando o parser de configuração...')
    expect(fitted.length).toBeLessThanOrEqual(40)
  })

  test('measures by display width, not code units', () => {
    const fitted = fitSpinnerMessage('修复身份验证错误并更新测试用例…', 20)
    expect(fitted).toBe('修复身...')
  })
})

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const realLog = { ...(await import('src/shared/log.js')) }
const logErrorSpy = mock((_error: unknown) => {})
mock.module('src/shared/log.js', () => ({ ...realLog, logError: logErrorSpy }))
afterAll(() => {
  mock.module('src/shared/log.js', () => realLog)
})

import { ErrorBoundary } from 'src/platform/ErrorBoundary.js'

beforeEach(() => {
  logErrorSpy.mockClear()
})

describe('ErrorBoundary', () => {
  it('chama logError quando filho crasha', () => {
    const instance = new ErrorBoundary({ children: null })
    instance.componentDidCatch(new Error('test crash'))
    expect(logErrorSpy).toHaveBeenCalledTimes(1)
    const firstCall = logErrorSpy.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[0]).toBeInstanceOf(Error)
  })

  it('renderiza null por padrão quando hasError=true', () => {
    const boundary = new ErrorBoundary({ children: React.createElement('span') })
    boundary.state = { hasError: true }
    expect(boundary.render()).toBeNull()
  })

  it('renderiza fallback prop quando hasError=true', () => {
    const fallback = React.createElement('span', null, 'fallback')
    const boundary = new ErrorBoundary({ children: React.createElement('span'), fallback })
    boundary.state = { hasError: true }
    expect(boundary.render()).toBe(fallback)
  })

  it('renderiza children quando não há erro', () => {
    const child = React.createElement('span', null, 'child')
    const boundary = new ErrorBoundary({ children: child })
    boundary.state = { hasError: false }
    expect(boundary.render()).toBe(child)
  })

  it('getDerivedStateFromError retorna hasError=true', () => {
    const state = ErrorBoundary.getDerivedStateFromError()
    expect(state).toEqual({ hasError: true })
  })

  it('chama onError com o erro, para o dono poder desmontar o boundary', () => {
    // Sem isso um throw dentro de um dialog era terminal: o root do Ink troca a
    // árvore inteira pela tela de erro e não reseta, então o REPL some. Quem
    // monta o boundary usa este callback para fechar o dialog.
    const onError = mock((_error: Error) => {})
    const error = new Error('dialog crashed')
    const instance = new ErrorBoundary({ children: null, onError })
    instance.componentDidCatch(error)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBe(error)
    expect(logErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('não quebra quando onError não é passado', () => {
    const instance = new ErrorBoundary({ children: null })
    expect(() => instance.componentDidCatch(new Error('boom'))).not.toThrow()
  })
})

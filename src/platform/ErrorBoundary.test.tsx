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
})

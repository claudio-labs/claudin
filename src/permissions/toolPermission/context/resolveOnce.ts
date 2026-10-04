export type ResolveOnce<T> = {
  resolve(value: T): void
  isResolved(): boolean
  claim(): boolean
}

type Stage = 'open' | 'claimed' | 'delivered'

/**
 * The first answer wins. A route that must do work before it can deliver
 * (save rules, record) claims first, so nobody else can answer meanwhile,
 * and delivers after.
 */
export function createResolveOnce<T>(deliver: (value: T) => void): ResolveOnce<T> {
  let stage: Stage = 'open'
  return {
    resolve(value) {
      if (stage === 'delivered') return
      stage = 'delivered'
      deliver(value)
    },
    isResolved: () => stage !== 'open',
    claim() {
      if (stage !== 'open') return false
      stage = 'claimed'
      return true
    },
  }
}

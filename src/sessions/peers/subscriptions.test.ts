import { afterEach, expect, test } from 'bun:test'

import {
  addIdleSubscription,
  MAX_SUBSCRIPTIONS,
  MAX_SUBSCRIPTIONS_PER_SENDER,
  resetIdleSubscriptionsForTests,
  takeAllIdleSubscriptions,
  takeIdleSubscriptions,
} from 'src/sessions/peers/subscriptions.js'

afterEach(() => {
  resetIdleSubscriptionsForTests()
})

test('a sender over its share loses its oldest subscription', () => {
  for (let i = 0; i <= MAX_SUBSCRIPTIONS_PER_SENDER; i++) {
    expect(addIdleSubscription({ id: `s${i}`, socketPath: '/s/1.sock', createdAt: i })).toBe(true)
  }
  expect(takeAllIdleSubscriptions().map(s => s.id)).toEqual(
    Array.from({ length: MAX_SUBSCRIPTIONS_PER_SENDER }, (_, i) => `s${i + 1}`),
  )
})

test('past the global cap a new subscription is refused', () => {
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
    addIdleSubscription({ id: `s${i}`, socketPath: `/s/${i}.sock`, createdAt: i })
  }
  expect(addIdleSubscription({ id: 'over', socketPath: '/s/new.sock', createdAt: 99 })).toBe(false)
})

test('an idle stretch takes only the subscriptions made before it began', () => {
  addIdleSubscription({ id: 'before', socketPath: '/s/1.sock', createdAt: 10 })
  addIdleSubscription({ id: 'after', socketPath: '/s/2.sock', createdAt: 30 })
  expect(takeIdleSubscriptions(20).map(s => s.id)).toEqual(['before'])
  expect(takeAllIdleSubscriptions().map(s => s.id)).toEqual(['after'])
})

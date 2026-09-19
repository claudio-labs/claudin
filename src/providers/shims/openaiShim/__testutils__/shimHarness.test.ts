// Pins the half of the shimHarness contract that nothing else can fail on.
//
// The other half is pinned by the ten openaiShim suites themselves: remove the
// `envProfileResolverArmed = true` from `useShimHarness`'s beforeEach and they
// go red immediately, because their transport-routing assertions need the
// env-synthesized profile.
//
// This file covers the opposite direction, which is silent. Arm the flag at
// module scope instead of per-test — the shape the pre-split file had — and
// every suite still passes except that the FIRST one's afterAll disarms the
// resolver for the rest of the run. Measured on this split: 17 of 75 tests
// fail, and which 17 depends on file order. Nothing here would notice, so the
// assertion below is deliberately about the flag rather than about a resolved
// profile: reading a real profile would depend on the developer's own
// settings.json and could not be asserted on at all (see testing.md).
//
// This file must NOT call useShimHarness().

import { expect, test } from 'bun:test'

import { isEnvProfileResolverArmed } from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

test('a suite that never opts in sees the real activeProvider resolver', () => {
  expect(isEnvProfileResolverArmed()).toBe(false)
})

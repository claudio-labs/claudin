// Reconstructed from its use sites: the original module was not carried into
// this fork. Every name it is asked for already exists elsewhere, so this is a
// pure re-export rather than a second declaration that could drift:
//
//   - `HookEvent` / `HookInput` are the SDK-facing types, generated from the
//     Zod schemas behind `src/entrypoints/agentSdkTypes.js`.
//   - `HookMatcher` is inferred from `HookMatcherSchema` in
//     `src/schemas/hooks.ts`, which is also what `HooksSettings` is built from
//     — the settings snapshot the only consumer stubs out.
//
// Its one consumer is `src/utils/hooks/matching.characterization.test.ts`.

export type { HookEvent, HookInput } from 'src/entrypoints/agentSdkTypes.js'
export type { HookMatcher } from 'src/schemas/hooks.js'

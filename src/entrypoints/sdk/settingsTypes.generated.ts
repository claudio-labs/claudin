// SDK Settings Types — the public `Settings` shape.
//
// `agentSdkTypes.ts` describes this module as "generated from settings JSON
// schema", but the generator was not carried into this fork. Rather than
// hand-write a second copy of the settings shape that would silently drift from
// the one the CLI actually validates against, this re-exports the type inferred
// from `SettingsSchema` in `utils/settings/types.ts` — the Zod schema that every
// settings file in this repo is parsed with.
//
// If the upstream generator is ever restored, it should produce a structurally
// identical type; until then this stays derived, so a schema change reaches SDK
// consumers automatically.

export type { SettingsJson as Settings } from '../../utils/settings/types.js'

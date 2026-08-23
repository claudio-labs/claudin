// Real captured command output for the elixir filters (mix compile / format).
//
// NOT synthetic. Each const is verbatim output of the named tool, with a
// `// source:` pointer so the origin is auditable:
//   - rtk  → ../rtk/src/filters/<cmd>.toml `[[tests.X]]` (real captures the
//            rtk project shipped) or ../rtk/src/cmds/<lang>/<cmd>.rs.
//   - web  → CI logs / GitHub issues / docs (URL in the comment).
//
// Convention per command: an `*_OK` (success / up-to-date — exercises the
// short-circuit) and an `*_ERR` (failure / diagnostics — proves the
// `unless: HAS_ERROR` guard preserves the failure).
//
// NOT a `.test` file — pure data.

// source: ../rtk/src/filters/mix-compile.toml [[tests.mix-compile]]
export const MIX_COMPILE_WARN = `Compiling 12 files (.ex)
Generated my_app app

warning: variable "conn" is unused
  lib/router.ex:42
`;

// source: ../rtk/src/filters/mix-compile.toml [[tests.mix-compile]] "only noise"
export const MIX_COMPILE_OK = `Compiling 3 files (.ex)
Generated my_app app
`;

// source: ../rtk/src/filters/mix-format.toml [[tests.mix-format]] "changed files".
// `mix format --check-formatted` lists unformatted files; the list is signal.
export const MIX_FORMAT_FILES = `lib/my_app.ex
test/my_app_test.exs
`;

# Spec: `skills/bundledSkills` and `skills/bundledSkillsRoot`

## Purpose

The registry of the skills that ship inside the CLI (`/verify`, `/simplify`,
`/create`, …). Each bundled skill module under `src/skills/bundled/` registers a
definition at startup. The command registry then lists them next to the
skills loaded from disk, and the model or the user invokes them like any other
prompt command.

Some bundled skills carry reference files (examples, templates). These are
written to a private temp directory the first time the skill runs, so the model
can Read or Grep them the same way it does for a skill that lives on disk.

## Public contract

These must keep their names and types: the modules that have not been
rewritten yet import them.

| Export | Signature | Used by |
|---|---|---|
| `BundledSkillDefinition` (type) | `{ name: string; description: string; aliases?: string[]; whenToUse?: string; argumentHint?: string; allowedTools?: string[]; model?: string; disableModelInvocation?: boolean; userInvocable?: boolean; isEnabled?: () => boolean; hooks?: HooksSettings; context?: 'inline' \| 'fork'; agent?: string; files?: Record<string, string>; getPromptForCommand: (args: string, context: ToolUseContext) => Promise<ContentBlockParam[]> }` | `src/plugins/builtinPlugins.ts`, `src/shared/types/plugin.ts`, every file in `src/skills/bundled/` |
| `registerBundledSkill` | `(definition: BundledSkillDefinition) => void` | every file in `src/skills/bundled/` |
| `getBundledSkills` | `() => Command[]`. The rewrite narrows this to `(CommandBase & PromptCommand)[]`, which every `Command[]` consumer still accepts. | `src/commands/commands.ts`, the bundled-skill tests |
| `clearBundledSkills` | `() => void` | tests |
| `getBundledSkillExtractDir` | `(skillName: string) => string` | tests; part of the contract because the permission layer has to agree with it |
| `getBundledSkillsRoot` (in `bundledSkillsRoot.ts`) | `() => string` | `src/permissions/filePermissions/internalPaths.ts`, which allowlists reads under it |

`bundledSkillsRoot.ts` must stay a leaf module. The permission layer imports
it, and it must not drag the tool types in with it.

## Observable behaviour

1. **The extraction root.**
   - It is `<per-user temp dir>/bundled-skills/<CLI version>/<random>`. The per-user temp dir is `getClaudeTempDir()` from `src/platform/tmpdir.ts`, and `<random>` is 32 lowercase hex digits (128 bits) drawn once per process.
   - Every call in the same process returns the same path.
   - The CLI version is `MACRO.VERSION`.
2. **A skill's extraction directory** is the root joined with the skill's name.
3. **Registering** appends one `Command` to the registry. The registry keeps registration order. The command has:
   - `type: 'prompt'`, and `name` and `description` taken from the definition;
   - `aliases`, `whenToUse`, `argumentHint`, `model`, `hooks`, `context`, `agent` and `isEnabled` copied as given (undefined when absent);
   - `allowedTools` as given, or `[]` when absent;
   - `disableModelInvocation` as given, or `false`;
   - `userInvocable` as given, or `true`, and `isHidden` equal to `!userInvocable`;
   - `hasUserSpecifiedDescription: true`, `contentLength: 0`, `source: 'bundled'`, `loadedFrom: 'bundled'` and `progressMessage: 'running'`;
   - `skillRoot` equal to the skill's extraction directory when the definition has at least one reference file, and undefined otherwise (an empty `files` map counts as none);
   - `getPromptForCommand` as described in the next item.
4. **Invoking** a skill.
   - With no reference files, the command returns exactly what the definition returns for the same arguments and context.
   - With reference files:
     - The first invocation writes the files. Nothing is written at registration time.
     - The files are written once per process. Concurrent first invocations share the same write, and later invocations reuse its result.
     - The definition's prompt is then called with the same arguments and context, and prefixed with the announcement `Base directory for this skill: <dir>` followed by one blank line (`<dir>\n\n`).
     - If the prompt starts with a text block, the announcement is prepended to that block's text. Otherwise the announcement becomes a new first text block. An empty prompt becomes that single block.
     - If writing failed, the prompt is returned unannounced, the failure is logged at debug level, and nothing is thrown. The skill still works; it just lacks the files.
5. **`getBundledSkills`** returns a copy. Changing the returned array never changes the registry.
6. **`clearBundledSkills`** empties the registry.

## Security requirements

The reference files are read back into the model's context, and reads under
the root are allowlisted without a prompt. So the files must be ones this
process wrote, and nobody else can have planted them. The rules below are
observable, and the tests check each one.

- **The random root segment** is the primary defence. Every other part of the path is public, and on a shared `/tmp` another local user could pre-create it.
- **Directories** the extraction creates are owner-only (0700), and **files** are owner-only (0600), whatever the umask.
- **Every file is created exclusively.** If anything already exists at the target (a file, or a symlink to somewhere else), the extraction fails. It does not overwrite, and it never follows the link.
- **A key that is absolute, or that climbs out of the skill directory** through `..` (in any position, with either separator), fails the extraction before anything is written for it.

Defence in depth that the tests cannot observe, but which the implementation
should keep: open with no-follow on the final component, in addition to
exclusive create. On Windows, use the string flags for exclusive create,
because the numeric flags can fail with EINVAL there.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| Traversal, absolute key, pre-existing file or symlink, any I/O error | an unannounced prompt, and a debug log |
| The same skill invoked again after a failed write | still unannounced; the write is not retried within the process |
| `files: {}` | treated as no files: no `skillRoot`, no announcement |

## Tests that pin it

- `src/skills/bundledSkills.characterization.test.ts`: 20 tests, 100% line and function coverage of the old modules.
- `scripts/migrations/probes/rewrite-bundledSkills.json`: 32 probes, every one of which turns the suite red on the old code.
- `src/skills/bundled/*.test.ts` go through the registry indirectly.

## Out of scope

Nothing is dropped.

## Outcome (2026-09-27)

This was the first module rewritten under the process, with the implementation
written in a sandbox that had no history and no old code in it. The
characterization suite passed unchanged. The probe spec was rewritten against
the new code, and all 33 of its probes turn the suite red.

**Deliberate differences from the old module:**
- **`..` in a key.** Any `..` segment is refused, even one that normalizes back inside the directory. The old module accepted `ok/../x.md`.
- **Validation before writing.** Every key is checked before anything is written, so a bad key leaves no partial extraction behind.
- **The root is memoized by hand.** A clearable lodash cache could otherwise move the root after files had been written under it.

**Residue.** The gate still finds 31 lines of `bundledSkills.ts`. They were
reviewed, and all of them are public contract the callers dictate:
- the fields of `BundledSkillDefinition`, in the order this spec listed them;
- the signatures of `clearBundledSkills` and `getBundledSkillExtractDir`;
- the `field: definition.field` lines that map a definition onto a `Command`.

They go when the contract is redesigned, after every consumer has been
rewritten. `bundledSkillsRoot.ts` measures zero.

**Finding, not fixed here.** Nothing checks who owns the per-user temp dir
(`/tmp/claude-<uid>`) or the directories between it and the random segment.
Another local user who creates them first can list their own directory, learn
the random segment, and swap the extracted files. The old module had the same
gap. See the team bug memory `tmpdir-ownership-unchecked`.

## Target design

- **The root module.** Keep it a leaf: one exported, memoized function and no other imports from the skills slice.
- **The registry module.** Separate three concerns:
  - turning a definition into a `Command` (pure);
  - the registry itself (a module-private list with copy-out reads);
  - extracting reference files (path validation, safe exclusive writes, the per-skill once-only memo).

  The announcement prefix belongs with the invocation wrapper, not with the extraction.
- **Types.** Explicit throughout, and no `any`. Errors are reported through the debug log, never swallowed silently.

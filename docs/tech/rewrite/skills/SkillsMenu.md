# Spec: `skills/ui/SkillsMenu`

## Purpose

The `/skills` dialog. It lists every skill the session has, grouped by where
each one came from, next to the estimated token cost of the part of the skill
that sits in the prompt ahead of time (its name, description and
when-to-use). It is read-only: nothing is selected or run from it, and the
only action is closing it.

`src/commands/skills/skills.tsx` is the only caller. When the user types
`/skills`, it renders the dialog with the command's completion callback as
`onExit` and the session's full command list (`context.options.commands`) as
`commands`. The dialog does not close itself: it reports through `onExit`, and
the caller takes it off the screen.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `SkillsMenu` | a React function component taking `{ onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void; commands: Command[] }` | `src/commands/skills/skills.tsx` |

`Command` and `CommandResultDisplay` come from `src/commands/commands.ts`,
which re-exports them from `src/shared/types/command.ts`. The props type is not
exported and nothing imports it, so the rewrite may export it by name.

The values the dialog shows are defined by these exports of the project's
own code, and the tests compute their expectations with them. The rewrite has
to use them rather than reimplement them:

| Value | Defined by |
|---|---|
| a skill's estimate | `estimateSkillFrontmatterTokens` (`src/skills/loadSkillsDir.ts`), formatted with `formatTokens` (`src/shared/text/format.ts`) |
| a group's directory | `getSkillsPath` (`src/skills/loadSkillsDir.ts`), shown through `getDisplayPath` (`src/shared/fs/file.ts`) |

## Observable behaviour

### 1. Which commands are skills

A command is listed when both of these hold:
- it is a prompt command (`type: 'prompt'`);
- its `loadedFrom` is `skills`, `commands_DEPRECATED`, `plugin` or `mcp`.

Nothing else is looked at. A skill with `isHidden`, `userInvocable: false` or
`disableModelInvocation: true` is still listed.

Everything else is left out:
- local and local-JSX commands, whatever their `loadedFrom`;
- prompt commands whose `loadedFrom` is `bundled`, `managed` or absent. That
  covers the bundled skills, the built-in prompt commands, MCP prompts that
  are not skills, and plugin commands that are not skills.

### 2. The empty state

When no command is listed, the dialog shows, top to bottom:
- the title `Skills` and, under it, the subtitle `No skills found`;
- a blank line, then `Create skills in .claudin/skills/ or ~/.claudin/skills/`
  (dim);
- a blank line, then the close hint `Esc to close` (dim, italic).

The directions are fixed text. They do not follow `CLAUDIN_CONFIG_DIR`.

### 3. The listing

Top to bottom:
- a rule across the full width, with a blank line above it (the design-system
  pane's frame);
- the title `Skills` (bold, in the dialog's colour) and, under it, the dim
  subtitle `<N> skills`, or `1 skill` when there is one. N counts every listed
  skill, across all groups (but see Edge cases);
- one block per group, each preceded by a blank line;
- a blank line, then the close hint `Esc to close` (dim, italic).

The design-system dialog's usual `Enter to confirm · Esc to cancel` guide is
not shown. The close hint shows the key bound to `confirm:no` in the
`Confirmation` keybinding context, which is `Esc` in the default bindings,
followed by `to close`. Everything under the rule is indented two columns.

**Groups.** A source with no listed skill gets no block at all. The order and
the titles are fixed:

| Order | `source` | Title | Subtitle |
|---|---|---|---|
| 1 | `projectSettings` | `Project skills` | its directory |
| 2 | `userSettings` | `User skills` | its directory |
| 3 | `policySettings` | `Managed skills` | its directory |
| 4 | `plugin` | `Plugin skills` | the word `plugin` |
| 5 | `mcp` | `MCP skills` | its servers, or none |

A group's heading is one line: the title (bold, dim), then, when there is a
subtitle, a space and the subtitle in parentheses (dim). For example,
`Project skills (.claudin/skills)`.

**Subtitles.**
- **Project, user and managed:** the display form (`getDisplayPath`) of
  `getSkillsPath(source, 'skills')`. When at least one skill in that group has
  `loadedFrom: 'commands_DEPRECATED'`, a comma, a space and the display form of
  `getSkillsPath(source, 'commands')` follow. On Linux, with the default config
  home, that reads `.claudin/skills`, `~/.claudin/skills`,
  `/etc/claude-code/.claudin/skills` and `.claudin/skills, .claudin/commands`.
- **Plugin:** the word `plugin`, so the heading reads `Plugin skills (plugin)`.
- **MCP:** the servers the group's skills come from. A skill's server is the
  part of its name before the first `:`, and only when the name does not start
  with `:`. Each server appears once, in the order in which the rows list them,
  joined by `, `. When no skill names a server, there is no subtitle and no
  parentheses.

**Rows.** One line per skill, under its group's heading, sorted by `name`
with `String.prototype.localeCompare` and no locale or options. So `alpha`,
`Bravo`, `charlie`, where code-unit order would put `Bravo` first. A row reads:
- the label, in the default colour: the skill's `name`. When the name contains
  a `:`, the label goes on with ` - ` and the part after the last `:`, so
  `frontend:lint - lint` and `infra:deploy:canary - canary`. The label always
  uses `name`, never `userFacingName()`;
- then, dim, for a skill whose `source` is `plugin` and whose
  `pluginInfo.pluginManifest.name` is not empty: ` · ` and that plugin name. A
  skill from any other source never shows one, even when it carries
  `pluginInfo`;
- then, dim: ` · ~`, the estimate, and ` description tokens`. The estimate is
  `formatTokens(estimateSkillFrontmatterTokens(skill))`, for example `~7`,
  `~1.5k` or `~2k`.

A full row reads `tools:format - format · code-tools · ~9 description tokens`.
The skill's description itself is not shown.

### 4. Keys

- **`Esc` and `n`** close the dialog. Each press calls
  `onExit('Skills dialog dismissed', { display: 'system' })` exactly once, in
  the listing and in the empty state alike. `display: 'system'` asks the caller
  to show the result as a system message (`LocalJSXCommandOnDone`,
  `src/shared/types/command.ts`).
- **Nothing else does anything.** Enter, `y`, the arrow keys, Tab, Shift+Tab,
  space and other letters neither call `onExit` nor change the screen. There
  is no cursor, no selection and no scrolling.
- **Ctrl+C and Ctrl+D** belong to the design-system dialog, not to this
  component, and never call `onExit`. A quick second Ctrl+C exits the
  application, as in every such dialog. The "press again to exit" notice lives
  in the dialog's input guide, which this dialog hides, so the first press
  shows nothing.
- The dialog never calls `onExit` on its own.

## Edge cases and errors

| Case | What the user sees | Pinned |
|---|---|---|
| No commands, or none that are skills | the empty state | yes |
| A skill whose `loadedFrom` qualifies but whose `source` is `localSettings`, `flagSettings`, `builtin` or `bundled` | Not listed. It is still counted in the header, so the count can be larger than the number of rows. No loader produces such a skill today. | not listed: yes. The count: no |
| Two skills with the same name in one group | Both are listed. The old module gave the two rows the same React key, and React warns about it on stderr. | both listed: yes |
| A name that starts with `:` (MCP) | The label `:x - x`, and no server | yes |
| A name that ends with `:`, such as `odd:` | The label `odd: - ` with an empty last segment. In the MCP group, `odd` is a server. | no |
| A plugin skill without `pluginInfo` | no plugin segment | yes |
| A plugin skill whose manifest name is empty | no plugin segment | no |
| A plugin-group skill with `loadedFrom: 'commands_DEPRECATED'` | The subtitle `plugin, plugin`. No loader produces one: plugin commands that are not skills have no `loadedFrom`. | no |
| A narrow terminal | **Broken in the old module.** The heading and each row wrap as independent side-by-side columns and lose characters. At 36 columns, `managed-one` came out as `managed-on`, and `Managed skills (/etc/…)` split into `Managed` / `skills` beside the wrapped path. See `.claudin/rules/ink-tui.md` §10. | no: the old output is wrong |
| A long list | Every row is rendered. The dialog grows and does not scroll. | no |
| A new `commands` array while the dialog is open | The listing follows it. The only caller passes a fixed array. | no |
| `CLAUDIN_CONFIG_DIR` set | The user group's directory follows it through `getSkillsPath`. The empty-state directions do not. | yes, both |

## Tests that pin it

- **`src/skills/ui/SkillsMenu.characterization.test.tsx`.** 25 tests. They cover 100% of the functions and 92.04% of the lines of the old module. The uncovered lines are the compiler output's cache hits, which no behaviour reaches. It runs in about 6 s and passed three runs in a row.
- **How the suite observes the dialog.** The rewrite has to keep working under this harness:
  - It mounts the component in a real Ink root (`createRoot`), inside `AppStateProvider` and `KeybindingSetup` and nothing else. The stdin is a fake TTY, and the stdout is 120 columns wide, so nothing wraps.
  - It reads the last painted frame and splits it on blank lines into the header, one block per group, and the close hint. So the blank lines of section 3 are pinned. Each line is trimmed, and the rule is dropped.
  - It computes each estimate and each directory with the functions in the Public contract table.
  - It sends keys as raw sequences on stdin. A closing key is re-sent when nothing happened within 2 s, because a key that arrives before the input handlers subscribe is dropped.
  - It does not use `renderToString`. Under `bun test` the process stdin is not a TTY, so the dialog's key handling fails to enable raw mode, and each static render waits out a 3 s timeout.
- **`scripts/migrations/probes/rewrite-SkillsMenu.json`.** 25 probes against the old module, and every test is the target of at least one.
- **No other test** renders `SkillsMenu`.

**Not pinned, and why:**
- **The narrow-width layout.** The old output is wrong there (see Edge cases), so pinning it would pin the bug.
- **Styling** (bold, dim, italic, colour). The ANSI output depends on the colour level of the test process.
- **The header count** when a skill's source is not one of the five groups.
- **Ctrl+C and Ctrl+D.** They are the design-system dialog's behaviour, and a second press exits the process that runs the suite.
- **The rows marked "no"** in the table above.

## Out of scope

Nothing is dropped.

## Findings

Each one is described, not fixed. The decision column says what the rewrite
does.

| Finding | Decision |
|---|---|
| **The narrow-width corruption** (Edge cases). It is the symptom `.claudin/rules/ink-tui.md` §10 describes. | Fix. Each heading and each row is one `<Text>`, with the dim parts as nested spans. Pin it with a narrow-width render in the new module's own tests, and record it in the Outcome. |
| **The count and the rows can disagree** for a skill from another source. | Recommended fix: count only the listed skills. The suite leaves it open, so record whichever is chosen. |
| **The duplicate React key** for two same-named skills in one group. | Fix. Keys stay unique within a group. The suite pins that both rows are listed. |
| **`Plugin skills (plugin)`.** The subtitle carries no information. | Keep for parity, since it is pinned. Showing the plugin names instead is a separate change, after the rewrite. |
| **The empty-state directions** ignore `CLAUDIN_CONFIG_DIR`. | Keep for parity, since it is pinned. |
| **The label repeats the last segment** (`frontend:lint - lint`). | Keep for parity, since it is pinned. |
| **The first Ctrl+C shows nothing,** because the input guide is hidden. | Keep. It is the design-system dialog's behaviour. |

## Target design

- **A hand-written function component** in this repo's Ink style: typed props, and no React Compiler output (no cache slots). It keeps the export name and the props.
- **A pure model beside it** in `src/skills/ui/`, testable without Ink or module mocks:
  - the filter of section 1, as a type guard onto `CommandBase & PromptCommand`;
  - the groups of section 3, as a table with one row per displayed source (its title and its subtitle rule), in display order, so a new source is a new row rather than another branch (`.claudin/rules/code-design.md`, Open/closed);
  - sorting, and dropping the empty groups;
  - the label, the plugin segment and the estimate text of a row;
  - the server list of the MCP group.

  The model takes its collaborators through a narrow `…Deps` parameter: a directory for a source, and an estimate for a skill. The component wires in `getSkillsPath`, `getDisplayPath`, `estimateSkillFrontmatterTokens` and `formatTokens`, so the model's unit tests need no real paths or token ratio (`.claudin/rules/code-design.md`, sections I and D).
- **The dialog.** Render the design-system `Dialog` (`src/terminal/design-system/Dialog.tsx`) with the title `Skills`, the count as its subtitle, and its input guide hidden. Its cancel action calls `onExit` as section 4 describes. The close hint goes through the shortcut-hint component that follows the keybinding display, so it shows the key bound to `confirm:no`.
- **Layout.** One logical line is one `<Text>` (see Findings). The groups sit in a column with a one-line gap. Row keys are unique within a group.
- **Types.** Explicit throughout, with no `any`. Any regex lives at module level.
- **Tests.**
  - The characterization suite, unchanged.
  - Unit tests for the model.
  - One render at a narrow width, which asserts that a row's label and estimate stay whole and in order.

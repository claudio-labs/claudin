/**
 * Shared types for the keybinding system.
 *
 * This module was reconstructed from its use sites: the original was not
 * carried into this fork, but ~31 type-only imports across the repo reference
 * it. Every shape below is derived from code that constructs or destructures
 * these values — see the per-type notes for the anchor files.
 *
 * Runtime counterparts of the two unions live in `./schema.ts`
 * (`KEYBINDING_CONTEXTS`, `KEYBINDING_ACTIONS`) and in `./validate.ts`
 * (`VALID_CONTEXTS`). Those lists are what a user's `keybindings.json` is
 * validated against, and they are deliberately NARROWER than the unions here:
 * the `Scroll` and `MessageActions` contexts (and their actions) ship in
 * `DEFAULT_BINDINGS` but are absent from the schema, so they work as defaults
 * and cannot be rebound. Keep that in mind before "syncing" the lists.
 */

/**
 * A single resolved keystroke: the normalized key name plus its modifiers.
 *
 * Produced by `parseKeystroke` (parser.ts) and by `buildKeystroke`
 * (resolver.ts); every field is always set, never optional.
 *
 * `alt` and `meta` are aliases for the same physical modifier — terminals
 * cannot distinguish them, so `modifiersMatch` (match.ts) tests `alt || meta`.
 * `super` (cmd/win) is distinct and only arrives via the kitty keyboard
 * protocol.
 */
export type ParsedKeystroke = {
  /**
   * Normalized key name, lowercased. Named keys use the spellings
   * `getKeyName` (match.ts) emits — `escape`, `enter`, `tab`, `backspace`,
   * `delete`, `up`, `down`, `left`, `right`, `pageup`, `pagedown`, `wheelup`,
   * `wheeldown`, `home`, `end` — and space is the literal `' '`.
   */
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

/**
 * A key sequence. Single-keystroke bindings are chords of length 1; multi-key
 * bindings like `ctrl+x ctrl+e` are longer.
 */
export type Chord = ParsedKeystroke[]

/**
 * A UI context that scopes a binding. `Global` bindings apply everywhere;
 * more specific contexts take precedence (see `useKeybinding`).
 *
 * The first 18 mirror `KEYBINDING_CONTEXTS` in schema.ts. `Scroll` and
 * `MessageActions` are used by `DEFAULT_BINDINGS` but are not in the schema,
 * so they are default-only (see the module note above).
 */
export type KeybindingContextName =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Confirmation'
  | 'Help'
  | 'Transcript'
  | 'HistorySearch'
  | 'Task'
  | 'ThemePicker'
  | 'Settings'
  | 'Tabs'
  | 'Attachments'
  | 'Footer'
  | 'MessageSelector'
  | 'DiffDialog'
  | 'ModelPicker'
  | 'Select'
  | 'Plugin'
  // Default-only contexts, absent from schema.ts:
  | 'Scroll'
  | 'MessageActions'

/**
 * Every action identifier the app dispatches on. Mirrors `KEYBINDING_ACTIONS`
 * in schema.ts, plus the `scroll:` / `selection:` / `messageActions:` families
 * that only exist in `DEFAULT_BINDINGS`.
 */
export type KnownKeybindingAction =
  // App-level actions (Global context)
  | 'app:interrupt'
  | 'app:exit'
  | 'app:toggleTodos'
  | 'app:toggleTranscript'
  | 'app:toggleBrief'
  | 'app:toggleTeammatePreview'
  | 'app:toggleTerminal'
  | 'app:redraw'
  | 'app:globalSearch'
  | 'app:quickOpen'
  // History navigation
  | 'history:search'
  | 'history:previous'
  | 'history:next'
  // Chat input actions
  | 'chat:cancel'
  | 'chat:killAgents'
  | 'chat:cycleMode'
  | 'chat:modelPicker'
  | 'chat:fastMode'
  | 'chat:thinkingToggle'
  | 'chat:increaseEffort'
  | 'chat:decreaseEffort'
  | 'chat:submit'
  | 'chat:newline'
  | 'chat:undo'
  | 'chat:externalEditor'
  | 'chat:openDiff'
  | 'chat:openExplorer'
  | 'chat:stash'
  | 'chat:imagePaste'
  | 'chat:messageActions'
  // Autocomplete menu actions
  | 'autocomplete:accept'
  | 'autocomplete:dismiss'
  | 'autocomplete:previous'
  | 'autocomplete:next'
  // Confirmation dialog actions
  | 'confirm:yes'
  | 'confirm:no'
  | 'confirm:previous'
  | 'confirm:next'
  | 'confirm:nextField'
  | 'confirm:previousField'
  | 'confirm:cycleMode'
  | 'confirm:toggle'
  | 'confirm:toggleExplanation'
  // Tabs navigation actions
  | 'tabs:next'
  | 'tabs:previous'
  // Transcript viewer actions
  | 'transcript:toggleShowAll'
  | 'transcript:exit'
  // History search actions
  | 'historySearch:next'
  | 'historySearch:accept'
  | 'historySearch:cancel'
  | 'historySearch:execute'
  // Task/agent actions
  | 'task:background'
  // Theme picker actions
  | 'theme:toggleSyntaxHighlighting'
  // Help menu actions
  | 'help:dismiss'
  // Attachment navigation (select dialog image attachments)
  | 'attachments:next'
  | 'attachments:previous'
  | 'attachments:remove'
  | 'attachments:exit'
  // Footer indicator actions
  | 'footer:up'
  | 'footer:down'
  | 'footer:next'
  | 'footer:previous'
  | 'footer:openSelected'
  | 'footer:clearSelection'
  | 'footer:close'
  // Message selector (rewind) actions
  | 'messageSelector:up'
  | 'messageSelector:down'
  | 'messageSelector:top'
  | 'messageSelector:bottom'
  | 'messageSelector:select'
  // Diff dialog actions
  | 'diff:dismiss'
  | 'diff:previousSource'
  | 'diff:nextSource'
  | 'diff:focusList'
  | 'diff:focusContent'
  | 'diff:viewDetails'
  | 'diff:previousFile'
  | 'diff:nextFile'
  | 'diff:nextTab'
  | 'diff:refresh'
  | 'diff:expandAll'
  // Model picker actions (internal-only)
  | 'modelPicker:decreaseEffort'
  | 'modelPicker:increaseEffort'
  // Select component actions (distinct from confirm: to avoid collisions)
  | 'select:next'
  | 'select:previous'
  | 'select:accept'
  | 'select:cancel'
  // Search + favorites, registered only by SearchableSelect
  | 'select:search'
  | 'select:toggleFavorite'
  // Plugin dialog actions
  | 'plugin:toggle'
  | 'plugin:install'
  // Permission dialog actions
  | 'permission:toggleDebug'
  // Settings config panel actions
  | 'settings:search'
  | 'settings:retry'
  | 'settings:close'
  | 'settings:usageDay'
  | 'settings:usageWeek'
  // Voice actions
  | 'voice:pushToTalk'
  // Scroll + selection, default-only (ScrollKeybindingHandler.tsx)
  | 'scroll:lineUp'
  | 'scroll:lineDown'
  | 'scroll:halfPageUp'
  | 'scroll:halfPageDown'
  | 'scroll:pageUp'
  | 'scroll:pageDown'
  | 'scroll:fullPageUp'
  | 'scroll:fullPageDown'
  | 'scroll:top'
  | 'scroll:bottom'
  | 'selection:copy'
  // Message actions, default-only (messageActions.tsx)
  | 'messageActions:prev'
  | 'messageActions:next'
  | 'messageActions:prevUser'
  | 'messageActions:nextUser'
  | 'messageActions:top'
  | 'messageActions:bottom'
  | 'messageActions:escape'
  | 'messageActions:ctrlc'
  | 'messageActions:enter'
  | 'messageActions:c'
  | 'messageActions:p'

/**
 * What a keystroke triggers.
 *
 * Deliberately open rather than a closed union of {@link KnownKeybindingAction}:
 * a user binding may name any slash command as `command:<name>`
 * (schema.ts validates the shape, not the name), and `filterReservedShortcuts`
 * in template.ts round-trips bindings through `Record<string, string | null>`.
 * The `string & {}` arm keeps plain strings assignable while editors still
 * complete the known ids.
 *
 * `null` is not part of this type — it appears where a binding can be UNBOUND,
 * i.e. in {@link KeybindingBlock.bindings} and {@link ParsedBinding.action}.
 */
export type KeybindingAction =
  | KnownKeybindingAction
  | `command:${string}`
  // eslint-disable-next-line @typescript-eslint/ban-types -- LiteralUnion idiom: keeps completions without closing the union
  | (string & {})

/**
 * One context's worth of bindings, as they appear in `DEFAULT_BINDINGS` and in
 * a user's `keybindings.json`. Keys are keystroke patterns (`'ctrl+k'`,
 * `'shift+tab'`, `'ctrl+x ctrl+e'`); a `null` value unbinds a default.
 */
export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, KeybindingAction | null>
}

/**
 * A block entry after `parseBindings` (parser.ts) has flattened it: one row
 * per keystroke pattern, with the pattern already parsed into a chord.
 *
 * `action` is `null` for an explicit unbind, which `resolveKey` reports as
 * `{ type: 'unbound' }` rather than as a match.
 */
export type ParsedBinding = {
  chord: Chord
  action: KeybindingAction | null
  context: KeybindingContextName
}

# Spec: `mcp/elicitationDialog`

File: `src/mcp/ui/ElicitationDialog.tsx`.

## Purpose

When a connected MCP server elicits input, `mcp/elicitation` puts an
`ElicitationRequestEvent` on the app state's elicitation queue. The REPL shows
the head of that queue with `ElicitationDialog`, and this unit is that dialog.
It comes in two forms, picked by the request's mode:

- **The form** (`mode` absent or `form`): a list of typed fields drawn from the
  request's flat schema, which the user fills in with the keyboard, then an
  Accept and a Decline button. What the user filled in is what the server
  receives on Accept.
- **The link** (`mode: 'url'`): the server wants the user to visit a page. The
  dialog shows the URL, opens it in the browser on Accept, then waits for the
  server's completion notice.

The dialog does not check typed values itself. It classifies fields and checks
input through `mcp/elicitation` (`elicitationValidation.ts`), and opens pages
through `openBrowser` (`src/shared/browser.ts`). It never talks to the server:
every answer goes to the two callbacks, and the REPL turns them into the
server's `ElicitResult`.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `ElicitationDialog` | component, props `{ event: ElicitationRequestEvent; onResponse: (action: ElicitResult['action'], content?: ElicitResult['content']) => void; onWaitingDismiss?: (action: 'dismiss' \| 'retry' \| 'cancel') => void }` | `src/agent/repl/ui/REPLDialogs.tsx` (mounts it, keyed by server and request id); `src/agent/repl/REPL.tsx` imports it |

`ElicitationRequestEvent` is `mcp/elicitationHandler.ts`'s (see
[elicitation.md](elicitation.md)); the dialog reads its `serverName`,
`params`, `signal`, `waitingState` and `completed`. `ElicitResult` is the MCP
SDK's.

What the caller does with the callbacks, which this unit must keep feeding the
same way (`REPLDialogs.tsx`):
- `onResponse(action, content)` is passed to the event's `respond` as
  `{ action, content }`. The event then leaves the queue, except after a URL
  `accept`, which stays queued for the waiting phase.
- `onWaitingDismiss(action)` takes the event off the queue and calls the
  event's own `onWaitingDismiss`, which the tool-call retry flow
  (`mcp/client/callTool.ts`) sets.

Collaborators the tests use and the rewrite must keep using rather than
restate: the field checks and labels of `src/mcp/elicitationValidation.ts`,
`openBrowser` of `src/shared/browser.ts`, `Dialog`, `Byline`,
`KeyboardShortcutHint` and `ConfigurableShortcutHint` of
`src/terminal/design-system` and `src/terminal`, `TextInput` of
`src/terminal/text-input`, `useRegisterOverlay`, `useNotifyAfterTimeout`, and
the default key bindings of `src/terminal/keybindings/defaultBindings.ts`.

## Observable behaviour

Glyphs are those of the `figures` package on a Unicode terminal. The frame is
the design-system `Dialog` in the `permission` colour: a rule as wide as the
terminal, the title in bold, the subtitle dim under it, the body, and a dim
key guide on the last line.

### 1. Which dialog

1. `params.mode === 'url'` gives the link dialog. Anything else (no mode, or
   `form`) gives the form.

### 2. The form: what it shows

2. **Title** `MCP server “<server>” requests your input` (curly quotes), then
   the request's `message` as the subtitle.
3. **One entry per schema property**, in the schema's order. Each entry is one
   line, then the field's `description` (when present, dim, indented), then a
   line kept for its error message (blank when there is none).
4. **The entry line**: a pointer column (`❯` on the focused field), a status
   mark, then `<label>: <value>`. The label is the field's `title`, else its
   name. The status mark is, in this order of precedence:
   - a spinner (the braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) while a natural-language date
     is being resolved (§8);
   - `⚠` when the field has an error;
   - `✔` when the field has a value;
   - `*` when the field is required;
   - a blank otherwise.
5. **The value shown**, by kind (kinds as `mcp/elicitation` classifies them):
   - unset: `not set` (italic, dim), on every kind but the focused text and
     yes/no fields;
   - focused text, number or integer field: the live text input, with the
     placeholder `Type something…`;
   - text, number, integer not focused: the value as text. A `date` value is
     shown in US English as `Fri, Mar 15, 2024`, read as a local date. A
     `date-time` value is shown as `Fri, Mar 15, 2024, 2:30 PM UTC`, in the
     local zone with its short name. A value that does not parse as a date,
     or a `date` value without three dash-separated parts, is shown as given.
     The value kept and sent is always the ISO text;
   - yes/no: `☒` for yes and `☐` for no. Focused and unset, a dim `☐`;
   - single choice: the label of the chosen value (`oneOf` title, else the
     legacy `enumNames` entry, else the value). Focused, it is preceded by `▸`;
   - multi choice: the labels of the ticked values joined with `, `, in the
     order they were ticked. Focused, preceded by `▸`;
   - any other kind of property: its value as text, or `not set`.
6. **An open list** (single or multi choice, §7) replaces the value with `▾`
   and lists every option under the entry, indented: a pointer column (`❯` on
   the option under the cursor), then `◉`/`◯` (single: chosen or not) or
   `☒`/`☐` (multi: ticked or not), then the label.
7. **Defaults.** A property's `default` is the field's initial value, whatever
   its kind. A text, number, integer or single-choice field whose default fails
   the field check shows the check's message from the start, and holds Accept
   back like any other error.
8. **Scrolling.** The form shows as many entries as fit in
   `max(2, floor((rows − 14) / 3))`, which is 3 at 24 rows. With more fields,
   the window keeps the focused field near its middle, never runs past the
   last field, and stays on the last fields while a button is focused. Lines
   `↑ <n> more above` and `↓ <n> more below` (dim) count the hidden entries.
9. **The buttons**, one line under the fields: `Accept` and `Decline`, the
   focused one bold with a `❯` before it (green for Accept, red for Decline).
10. **The key guide**: `Esc to cancel · ↑↓ to navigate`, and with a field
    focused also `· Backspace to unset`, then by kind: `· Space to toggle`
    (yes/no), `· → to expand` (closed choice or multi choice), `· Space to
    select` (open choice), `· Space to toggle` (open multi choice). After a
    first Ctrl+C on a button it reads `Press Ctrl-C again to exit`.
11. **Focus at start**: the first field, or the Accept button when the schema
    has no properties.

### 3. The form: keys

Down and Up move through the fields, then Accept, then Decline, and wrap
around (Up from the first field goes to Decline). Moving away from a field
commits it (§5) and closes its list. While a button is focused, Left and Right
swap Accept and Decline.

12. **Text, number and integer fields** are edited in place while focused.
    Every keystroke is committed and checked at once:
    - the check's value is kept, so a number or integer field holds a number;
      a plain string is kept exactly as typed, spaces included;
    - a failed check keeps the raw text and shows the check's message (for
      example `Must be an integer between 1 and 5`,
      `Must be a valid email address, e.g. user@example.com`);
    - emptied (or only spaces): a number, integer or formatted string becomes
      unset and its error goes. A plain string becomes the empty string if it
      held a value, and stays unset if it did not;
    - Backspace in an empty input unsets the field and drops its error;
    - Enter moves to the next item, like Down;
    - returning to a field puts its value back in the input.
13. **Yes/no fields**: Space toggles (unset → yes → no → yes). Typing selects
    by prefix against `yes` and `no` (§6). Backspace unsets. Enter moves on.
    Other keys do nothing.
14. **Single choice, closed**: Right opens the list with the cursor on the
    chosen option (the first when none). Typing a letter opens it on the first
    label starting with the typed prefix. Backspace unsets. Enter moves on.
15. **Single choice, open**: Up and Down move the cursor; Up on the first
    option and Down on the last close the list (Down also moves to the next
    item), choosing nothing. Space chooses the option and closes, staying on
    the field. Enter chooses, closes and moves on. Left and Esc close without
    choosing, and Esc does not cancel the dialog. Typing moves the cursor by
    prefix. Other keys do nothing.
16. **Multi choice, closed**: as a closed single choice; Right opens with the
    cursor on the first option. Backspace clears every tick.
17. **Multi choice, open**: Space ticks or unticks the option under the cursor
    and leaves the list open. Enter ticks it (never unticks), closes and moves
    on. Up on the first option, Left and Esc close (Esc does not cancel); Down
    on the last closes and moves on. Typing moves the cursor by prefix, never
    ticking. Unticking the last option unsets the field.
18. **Item counts** of a multi choice are checked on each Space and when the
    list closes or the field is left:
    - below `minItems`: `Select at least <n> item(s)` (singular for 1), but
      only when something is ticked or the field is required;
    - above `maxItems`: `Select at most <n> item(s)`;
    - otherwise the message goes.

### 4. The form: answers

19. **Accept** (Enter on Accept) sends `onResponse('accept', content)` when
    every required field holds a value (not unset, not the empty string, not
    an empty list) and no field shows an error. `content` maps each field that
    holds a value to that value: strings as typed, numbers as numbers, yes/no
    as booleans, a single choice as its value (never its label), a multi
    choice as the array of ticked values. Unset fields are absent. With no
    fields, `content` is `{}`.
20. **Accept refused**: nothing is reported. Each required field that is unset
    shows `This field is required`. Focus moves to the first field that is
    unset-and-required or in error, and the buttons lose focus. Giving that
    field a value removes the required message.
21. **Decline** (Enter on Decline) sends `onResponse('decline')` with no
    content, whatever was filled in.
22. **Cancel** sends `onResponse('cancel')` with no content. It comes from:
    - Esc while a field is focused and no list is open;
    - Esc, or `n`, while a button is focused (or there are no fields);
    - the event's `signal` aborting while the dialog is up, or being aborted
      already when it mounts.
    `n` typed into a text field is a letter, and Esc in an open list only
    closes the list.
23. Nothing is ever reported twice by the keys above; each answer is one call.

### 5. Natural-language dates

24. A `date` or `date-time` field holding text that failed the plain check is
    resolved through `validateElicitationInputAsync` (`mcp/elicitation`),
    which may ask the small model. This happens:
    - when the user leaves the field (Down, Up or Enter); or
    - after 2 seconds without a keystroke in the field. Each keystroke
      restarts the wait; leaving the field cancels the wait and resolves at
      once, so the text is resolved only once.
    Text that passes the plain check is never resolved this way.
25. While it resolves, the field shows the spinner (§2.4). On success the field
    takes the returned ISO value and its error goes; if the input still shows
    the text that was resolved, it is replaced by the ISO value with the
    cursor at its end. On failure the raw text and its error stay, and Accept
    stays blocked.
26. A new resolution of the same field abandons the earlier one (its signal is
    aborted, its answer ignored). Closing the dialog abandons every resolution
    in flight and cancels any pending wait, so no model call starts after it
    is gone.

### 6. Typing ahead

27. Choices and yes/no fields keep one typed prefix, lower-cased, matched
    against the lower-cased labels. It is forgotten after 2 seconds without a
    keystroke, and when the focus moves with Up or Down. A prefix that matches
    nothing changes nothing.

### 7. The link dialog

28. **Asking.** Title `MCP server “<server>” wants to open a URL`, subtitle the
    `message`, then the URL in full with its host name in bold, then `Accept`
    and `Decline` (Accept focused), and the guide `Esc to cancel · ←→ to
    switch` (see finding 1 for how the arrows are drawn today). Text that is
    not a URL is shown as it is.
29. Left and Right swap the buttons. Enter on Decline sends
    `onResponse('decline')`. Esc or `n` send `onResponse('cancel')`. Neither
    opens anything.
30. **Enter on Accept** calls `openBrowser(url)` without waiting for it, sends
    `onResponse('accept')` with no content, and switches to waiting. The
    browser launcher refuses any scheme but `http` and `https`, so such a URL
    is never opened, but the dialog still answers `accept` and waits.
31. **Waiting.** Title `MCP server “<server>” — waiting for completion`, the
    `message`, the URL as before, the dim italic line `Waiting for the server
    to confirm completion…`, then the buttons `Reopen URL`, the action button
    and, when `waitingState.showCancel` is true, `Cancel`. The action button
    is labelled `waitingState.actionLabel`, or `Continue without waiting` when
    the event has no waiting state. `Reopen URL` is focused first.
32. Right and Left cycle through the waiting buttons and wrap at both ends.
    - Enter on `Reopen URL` opens the URL again and reports nothing.
    - Enter on the action button calls `onWaitingDismiss('retry')` when
      `showCancel` is set, otherwise `onWaitingDismiss('dismiss')`.
    - Enter on `Cancel`, or Esc, calls `onWaitingDismiss('cancel')`.
    - Nothing more goes to `onResponse` while waiting.
33. **Completion.** When the event arrives with `completed: true` while the
    dialog waits, it calls `onWaitingDismiss` by itself, with `retry` when
    `showCancel` is set and `dismiss` otherwise. A completion that arrives
    before Accept has no effect until Accept, which then ends the wait at
    once.
34. **The server cancels** (the `signal` aborts): while asking, or already
    aborted at mount, `onResponse('cancel')`; while waiting,
    `onWaitingDismiss('cancel')`.
35. Without an `onWaitingDismiss` prop the waiting keys report nothing and do
    not fail.

### 8. Side effects

36. While mounted, the form registers the overlay `elicitation` and the link
    dialog the overlay `elicitation-url` in the app state's `activeOverlays`;
    each removes it on unmount.
37. Both ask the idle notification hook for the message
    `Claudin needs your input`, with notification type `elicitation_dialog`
    (form) or `elicitation_url_dialog` (link). The hook stays silent under
    the test runner, so the suite pins only what is handed to it.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| a schema with no properties | Accept focused; Enter sends `accept` with `{}` |
| a required field unset, or a plain one emptied | Accept sends nothing (see finding 3 for the emptied case) |
| a text default that fails its check | flagged at mount; Accept blocked until fixed or unset |
| a choice default outside its list | flagged at mount with the allowed values; Accept blocked |
| more fields than fit | the window and the above/below counts of §2.8 |
| the request already aborted at mount | `cancel` at once (form and link) |
| the model fails or answers no date | the field keeps its text and error |
| the dialog closed during a resolution | the request is aborted, nothing reported |
| a URL with a non-web scheme | not opened; `accept` still sent |
| a URL that does not parse | shown whole, no bold part |
| a property of an unknown kind | shown as text or `not set`; its default is sent |

## Security requirements

- **Nothing is sent without the user's Accept.** Decline, Esc, `n` on a
  button, and the server's cancel never send content. An Esc inside an open
  list must not reach the dialog's cancel, and a letter typed into a text
  field must not cancel or accept.
- **Accept never sends a field in error or a missing required field**,
  including a bad default the user never touched.
- **A model's date is checked like typed input** before it becomes the
  field's value (that check belongs to `mcp/elicitation`), and an abandoned
  resolution never writes to the form.
- **The link dialog opens pages only through `openBrowser`**, which refuses any
  scheme but `http` and `https`. The dialog must not open a URL any other way.
- **The URL the user is shown is the URL that is opened.** See finding 4: the
  host highlighting garbles the shown URL when the host in it differs from its
  parsed form.

## Tests that pin it

- Three suites, 136 tests, passing on three runs in a row, with a shared rig
  `src/mcp/ui/__testutils__/elicitationRig.tsx` that mounts the dialog through
  `src/permissions/ui/__testutils__/promptFrameRig.tsx` (fake terminal, real
  key bindings, isolated config home):
  - `src/mcp/ui/ElicitationDialog.form.characterization.test.tsx` (101): the
    frame, the key guide, navigation and scrolling, every field kind, every
    answer, validation messages, ISO dates. `TZ` is `UTC`.
  - `src/mcp/ui/ElicitationDialog.url.characterization.test.tsx` (25): both
    phases of the link dialog. The browser is a real script named by
    `$BROWSER` that records each URL it is given.
  - `src/mcp/ui/ElicitationDialog.boundaries.characterization.test.tsx` (10):
    natural-language dates with `queryHaiku` (`src/providers/shims/claude.js`)
    replaced by a recorder the test answers, and the idle notification with
    `useNotifyAfterTimeout` replaced by a recorder.
- **Line coverage** of `ElicitationDialog.tsx`: 98.6% (959 of 973). Not
  reached, all without an observable effect or a path to reach them:
  - the fallback when formatting a valid date throws (it does not);
  - the memo-cache hits of the top-level component (re-render with identical
    props);
  - clearing a pending typeahead timer on unmount (it only resets the prefix);
  - moving the focus to "no field" by index (no key does);
  - a rejected async date check (`validateElicitationInputAsync` never
    rejects);
  - a required multi choice holding an empty list (an emptied list is stored
    as unset).
- `scripts/migrations/probes/rewrite-mcp-elicitationDialog.json`: 40 probes on
  `ElicitationDialog.tsx`; every accept, decline and cancel path is also
  mutated to fail open (to `accept`, or past the checks).
- No `feature()` flag is read in this unit.
- No other test mounts the dialog. `src/agent/repl/getFocusedInputDialog.test.ts`
  pins when the REPL shows it.

## Out of scope

- **Nothing is dropped.**
- **Elsewhere:** the field checks, labels and date parsing
  (`mcp/elicitation`), the queue and the REPL wiring that pops it
  (`REPLDialogs.tsx`), and the browser launcher (`src/shared/browser.ts`).

## Findings

1. **The link dialog's key guide shows `\u2190\u2192` literally.**
   - The arrow hint is written as an escape inside a JSX attribute, which is
     not unescaped, so the guide reads `Esc to cancel · \u2190\u2192 to
     switch` in both phases. The form's own `↑↓` hint is drawn right.
   - **Decision: fix.** Show `←→`. Nothing reads the guide. Not pinned (the
     suite matches any glyph between the words).
2. **An impossible `date` is displayed as a different, real date.**
   - `2025-02-30` is flagged as invalid, but the unfocused entry shows
     `Sun, Mar 2, 2025`.
   - **Decision: fix.** Show text that fails the date check as given. The
     value sent is unaffected. Not pinned (the suite checks only the `⚠`).
3. **Accept on a required plain-text field that was emptied does nothing,
   silently.**
   - The field holds the empty string, which Accept refuses, but no message
     appears and the focus stays on Accept.
   - **Decision: fix.** Treat it like a missing value: show
     `This field is required` and move to it. Pinned only as "nothing is
     sent".
4. **Security: the shown URL can differ from the opened one.**
   - The host is found by searching the URL text for the parsed host name. When
     the two differ (upper case `https://EXAMPLE.com/path`, or an IDN host,
     which parses to punycode), the shown line is garbled, e.g.
     `https://EXAMPLE.com/patexample.comAMPLE.com/path`. The opened URL is
     right, but the user judges the page by what is shown.
   - **Decision: fix.** Always show the URL exactly as given, and highlight the
     host only where it is found. Pure hardening: legitimate lower-case URLs
     look the same. Not pinned; the suite pins a lower-case URL shown whole
     with its host in bold.
5. **Enter in an open multi choice skips the `maxItems` check.**
   - With `maxItems: 1`, ticking one option with Space and then pressing Enter
     on another ticks both, closes the list without a message, and Accept
     sends both values.
   - **Decision: fix.** Check the count after Enter's tick, as Space does. The
     server's schema forbids the old result. Not pinned.
6. **Accept on a link that cannot be opened is still `accept`.**
   - The browser launcher refuses non-web schemes (and may fail for other
     reasons). The dialog answers `accept` before knowing, shows no error, and
     waits.
   - Only the tool-call retry flow queues URL events in the shipped client
     ([elicitation.md](elicitation.md), finding 5), and the server learns only
     that the user agreed.
   - **Decision: keep for parity.** Pinned with `file:///etc/passwd` (not
     opened, `accept` sent).
7. **`n` cancels the dialog whenever a button is focused** (the
   `Confirmation` binding), in both dialogs.
   - **Decision: keep for parity.** It matches the other confirmation dialogs.
     Pinned.
8. **Typing ahead mixes letters across choices.** On a yes/no field, `n` then
   `y` within 2 seconds is the prefix `ny`, which matches nothing, so the
   field stays `no`.
   - **Decision: keep for parity.** It is how the prefix search works for every
     choice. Pinned.
9. **The `elicitation_url_dialog` notification type is not offered as a
   Notification-hook matcher** in `src/platform/lifecycleHooks/hooksConfigManager.ts`,
   which lists `elicitation_dialog` only.
   - **Decision: track.** It belongs to the hooks UI, not to this unit.

## Target design

- **Same file and export.** `ElicitationDialog` keeps its props; the REPL
  imports it by path.
- **Split by responsibility**, under `src/mcp/ui/elicitation/`:
  - a pure **form model**: build the initial state from the schema (values
    from defaults, errors from the checks), and reduce it with explicit
    actions (`commitText`, `toggle`, `choose`, `tick`, `unset`, `move`,
    `submit`). `submit` returns either the content to send or the list of
    errors and the field to focus. The field kinds come from
    `mcp/elicitation`'s classifier, as a discriminated union;
  - a **key map** from Ink keys to those actions, per field kind and list
    state, so the key rules of §3 are a table rather than nested branches;
  - a **date resolver** hook that owns the 2-second wait and one abort
    controller per field, and reports `{ field, value | error }`;
  - small **views**: the entry line, the option list, the buttons, the scroll
    window (a pure function of field count, focus and rows), and the date
    display (a pure function, with finding 2 fixed);
  - the **link dialog** as its own component with a two-phase state machine
    (`asking` → `waiting`), and a pure URL splitter for the bold host
    (finding 4).
- **Types.** The callbacks' action unions stay as the SDK's. Form values are
  `string | number | boolean | string[]`, keyed by field name. No `any`.
- **Messages** (`This field is required`, `Select at least/at most …`, the
  titles and button labels) live as named constants.

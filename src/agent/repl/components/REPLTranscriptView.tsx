// Transcript-mode early-return view, extracted from `REPL.tsx` in Etapa 5
// of ROADMAP 11e (see the ROADMAP 11e plan).
//
// React-identity guarantees (the *point* of this extraction; see the team
// memory `activity-toggle-driven-only` and the plan's risk table):
//
//   * `scrollRef` and `jumpRef` are passed in as the SAME ref objects
//     created in REPL.tsx. Never recreate inside this module — the
//     virtual-scroll branch shares them with the main-mode render so that
//     transcript ↔ prompt toggle preserves scroll position and search
//     state.
//
//   * Hierarchy `<AlternateScreen>` → `<KeybindingSetup>` → content is
//     preserved exactly. AlternateScreen is wrapped here in
//     `renderTranscriptView` only for the virtual-scroll branch, matching
//     the original: the 30-cap dump branch returns the bare
//     `<KeybindingSetup>` tree so native terminal scrollback works.
//
// All props correspond 1:1 to the locals/state the original inline JSX
// closed over. They are passed as a single bag (`REPLTranscriptViewProps`)
// to avoid the closure-capture footgun called out in the plan's risk
// table: every callback below resolves from the bag, never from a
// destructured closure that could drift if React batched a re-render.

import { Box } from 'src/terminal/ink.js'
import * as React from 'react'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { GlobalKeybindingHandlers } from 'src/terminal/hooks/useGlobalKeybindings.js'
import { CommandKeybindingHandlers } from 'src/terminal/hooks/useCommandKeybindings.js'
import { CancelRequestHandler } from 'src/agent/hooks/useCancelRequest.js'
import { ScrollKeybindingHandler } from 'src/terminal/ScrollKeybindingHandler.js'
import { Messages } from 'src/agent/ui/Messages.js'
import { FullscreenLayout } from 'src/terminal/FullscreenLayout.js'
import { AlternateScreen } from 'src/terminal/ink/components/AlternateScreen.js'
import { SandboxViolationExpandedView } from 'src/components/SandboxViolationExpandedView.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from 'src/terminal/render/fullscreen.js'
import { AnimatedTerminalTitle } from 'src/agent/repl/components/AnimatedTerminalTitle.js'
import { TranscriptSearchBar } from 'src/agent/repl/components/TranscriptSearchBar.js'
import { TranscriptModeFooter } from 'src/agent/repl/components/TranscriptModeFooter.js'
import type { JumpHandle } from 'src/terminal/VirtualMessageList.js'

export type REPLTranscriptViewProps = {
  // identity-critical refs (see header)
  scrollRef: React.RefObject<unknown>
  jumpRef: React.RefObject<JumpHandle | null>
  // gate flags
  disableVirtualScroll: boolean
  dumpMode: boolean
  // <Messages> inputs
  transcriptMessages: unknown[]
  tools: unknown[]
  renderCommands: unknown[]
  inProgressToolUseIDs: Set<string>
  conversationId: string
  screen: 'prompt' | 'transcript'
  agentDefinitions: unknown
  transcriptStreamingToolUses: unknown
  showAllInTranscript: boolean
  handleOpenRateLimitOptions: () => void
  isLoading: boolean
  streamingThinking: unknown
  onSearchMatchesChange: (matches: unknown) => void
  scanElement: unknown
  setPositions: (positions: unknown) => void
  // top-level handler bags
  toolJSX: { jsx: React.ReactNode; isLocalJSXCommand?: boolean } | null
  titleIsAnimating: boolean
  terminalTitle: string
  titleDisabled: boolean
  showStatusInTerminalTab: boolean
  globalKeybindingProps: Record<string, unknown>
  // Pre-built voice keybinding element (or null). REPL owns the
  // feature('VOICE_MODE') gate and constructs the element so this view
  // never has to know about the voice subsystem's shape.
  voiceKeybindingSlot: React.ReactNode
  onSubmit: (...args: unknown[]) => unknown
  cancelRequestProps: Record<string, unknown>
  focusedInputDialog: string | undefined
  // search-bar interactions
  searchOpen: boolean
  searchCount: number
  searchCurrent: number
  searchQuery: string
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSearchCount: React.Dispatch<React.SetStateAction<number>>
  setSearchCurrent: React.Dispatch<React.SetStateAction<number>>
  setHighlight: (q: string) => void
  // footer status
  editorStatus: string | null
}

export function REPLTranscriptView(props: REPLTranscriptViewProps): React.ReactNode {
  // Virtual scroll replaces the 30-message cap: everything is scrollable
  // and memory is bounded by the viewport. Without it, wrapping transcript
  // in a ScrollBox would mount all messages (~250 MB on long sessions —
  // the exact problem), so the kill switch and non-fullscreen paths must
  // fall through to the legacy render: no alt screen, dump to terminal
  // scrollback, 30-cap + Ctrl+E. Reusing scrollRef is safe — normal-mode
  // and transcript-mode are mutually exclusive (this early return), so
  // only one ScrollBox is ever mounted at a time.
  const transcriptScrollRef = isFullscreenEnvEnabled() && !props.disableVirtualScroll && !props.dumpMode ? props.scrollRef : undefined
  const transcriptMessagesElement = (
    <Messages
      messages={props.transcriptMessages as never}
      tools={props.tools as never}
      commands={props.renderCommands as never}
      verbose={true}
      toolJSX={null}
      toolUseConfirmQueue={[]}
      inProgressToolUseIDs={props.inProgressToolUseIDs}
      isMessageSelectorVisible={false}
      conversationId={props.conversationId}
      screen={props.screen}
      agentDefinitions={props.agentDefinitions as never}
      streamingToolUses={props.transcriptStreamingToolUses as never}
      showAllInTranscript={props.showAllInTranscript}
      onOpenRateLimitOptions={props.handleOpenRateLimitOptions}
      isLoading={props.isLoading}
      hidePastThinking={true}
      streamingThinking={props.streamingThinking as never}
      scrollRef={transcriptScrollRef as never}
      jumpRef={props.jumpRef}
      onSearchMatchesChange={props.onSearchMatchesChange as never}
      scanElement={props.scanElement as never}
      setPositions={props.setPositions as never}
      disableRenderCap={props.dumpMode}
    />
  )
  const transcriptToolJSX = props.toolJSX && (
    <Box flexDirection="column" width="100%">
      {props.toolJSX.jsx}
    </Box>
  )
  const transcriptReturn = (
    <KeybindingSetup>
      <AnimatedTerminalTitle isAnimating={props.titleIsAnimating} title={props.terminalTitle} disabled={props.titleDisabled} noPrefix={props.showStatusInTerminalTab} />
      <GlobalKeybindingHandlers {...(props.globalKeybindingProps as React.ComponentProps<typeof GlobalKeybindingHandlers>)} />
      {props.voiceKeybindingSlot}
      <CommandKeybindingHandlers onSubmit={props.onSubmit as never} isActive={!props.toolJSX?.isLocalJSXCommand} />
      {transcriptScrollRef ?
        // ScrollKeybindingHandler must mount before CancelRequestHandler so
        // ctrl+c-with-selection copies instead of cancelling the active task.
        // Its raw useInput handler only stops propagation when a selection
        // exists — without one, ctrl+c falls through to CancelRequestHandler.
        <ScrollKeybindingHandler
          scrollRef={props.scrollRef as never}
          // Yield wheel/ctrl+u/d to UltraplanChoiceDialog's own scroll
          // handler while the modal is showing.
          isActive={props.focusedInputDialog !== 'ultraplan-choice'}
          // g/G/j/k/ctrl+u/ctrl+d would eat keystrokes the search bar
          // wants. Off while searching.
          isModal={!props.searchOpen}
          // Manual scroll exits the search context — clear the yellow
          // current-match marker. Positions are (msg, rowOffset)-keyed;
          // j/k changes scrollTop so rowOffset is stale → wrong row
          // gets yellow. Next n/N re-establishes via step()→jump().
          onScroll={() => props.jumpRef.current?.disarmSearch()}
        /> : null}
      <CancelRequestHandler {...(props.cancelRequestProps as React.ComponentProps<typeof CancelRequestHandler>)} />
      {transcriptScrollRef ?
        <FullscreenLayout
          scrollRef={props.scrollRef as never}
          scrollable={<>
            {transcriptMessagesElement}
            {transcriptToolJSX}
            <SandboxViolationExpandedView />
          </>}
          bottom={props.searchOpen ?
            <TranscriptSearchBar
              jumpRef={props.jumpRef}
              // Seed was tried (c01578c8) — broke /hello muscle
              // memory (cursor lands after 'foo', /hello → foohello).
              // Cancel-restore handles the 'don't lose prior search'
              // concern differently (onCancel re-applies searchQuery).
              initialQuery=""
              count={props.searchCount}
              current={props.searchCurrent}
              onClose={q => {
                // Enter — commit. 0-match guard: junk query shouldn't
                // persist (badge hidden, n/N dead anyway).
                props.setSearchQuery(props.searchCount > 0 ? q : '')
                props.setSearchOpen(false)
                // onCancel path: bar unmounts before its useEffect([query])
                // can fire with ''. Without this, searchCount stays stale
                // (n guard at :4956 passes) and VML's matches[] too
                // (nextMatch walks the old array). Phantom nav, no
                // highlight. onExit (Enter, q non-empty) still commits.
                if (!q) {
                  props.setSearchCount(0)
                  props.setSearchCurrent(0)
                  props.jumpRef.current?.setSearchQuery('')
                }
              }}
              onCancel={() => {
                // Esc/ctrl+c/ctrl+g — undo. Bar's effect last fired
                // with whatever was typed. searchQuery (REPL state)
                // is unchanged since / (onClose = commit, didn't run).
                // Two VML calls: '' restores anchor (0-match else-
                // branch), then searchQuery re-scans from anchor's
                // nearest. Both synchronous — one React batch.
                // setHighlight explicit: REPL's sync-effect dep is
                // searchQuery (unchanged), wouldn't re-fire.
                props.setSearchOpen(false)
                props.jumpRef.current?.setSearchQuery('')
                props.jumpRef.current?.setSearchQuery(props.searchQuery)
                props.setHighlight(props.searchQuery)
              }}
              setHighlight={props.setHighlight}
            /> :
            <TranscriptModeFooter
              showAllInTranscript={props.showAllInTranscript}
              virtualScroll={true}
              status={props.editorStatus || undefined}
              searchBadge={props.searchQuery && props.searchCount > 0 ? {
                current: props.searchCurrent,
                count: props.searchCount,
              } : undefined}
            />
          }
        /> :
        <>
          {transcriptMessagesElement}
          {transcriptToolJSX}
          <SandboxViolationExpandedView />
          <TranscriptModeFooter
            showAllInTranscript={props.showAllInTranscript}
            virtualScroll={false}
            suppressShowAll={props.dumpMode}
            status={props.editorStatus || undefined}
          />
        </>}
    </KeybindingSetup>
  )
  // The virtual-scroll branch (FullscreenLayout above) needs
  // <AlternateScreen>'s <Box height={rows}> constraint — without it,
  // ScrollBox's flexGrow has no ceiling, viewport = content height,
  // scrollTop pins at 0, and Ink's screen buffer sizes to the full
  // spacer (200×5k+ rows on long sessions). Same root type + props as
  // normal mode's wrap below so React reconciles and the alt buffer
  // stays entered across toggle. The 30-cap dump branch stays
  // unwrapped — it wants native terminal scrollback.
  if (transcriptScrollRef) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{transcriptReturn}</AlternateScreen>
  }
  return transcriptReturn
}


import chalk from 'chalk';
import React, { useMemo } from 'react';
import { useClipboardImageHint } from 'src/terminal/hooks/useClipboardImageHint.js';
import { useSettings } from 'src/platform/useSettings.js';
import { useTextInput } from 'src/terminal/hooks/useTextInput.js';
import { Box, color, useTerminalFocus, useTheme } from 'src/terminal/ink.js';
import type { BaseTextInputProps } from 'src/shared/types/textInputTypes.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import type { TextHighlight } from 'src/shared/text/textHighlighting.js';
import { BaseTextInput } from 'src/terminal/text-input/BaseTextInput.js';
export type Props = BaseTextInputProps & {
  highlights?: TextHighlight[];
};
export default function TextInput(props: Props): React.ReactNode {
  const [theme] = useTheme();
  const isTerminalFocused = useTerminalFocus();
  // Hoisted to mount-time — this component re-renders on every keystroke.
  const accessibilityEnabled = useMemo(() => isEnvTruthy(process.env.CLAUDIN_ACCESSIBILITY), []);
  const settings = useSettings();

  // Show hint when terminal regains focus and clipboard has an image
  useClipboardImageHint(isTerminalFocused, !!props.onImagePaste);

  // The cursor used to render a one-bar audio waveform while voice was
  // recording, animated at 50ms. That went with VOICE_MODE, and with it the
  // only reason this component subscribed to an animation frame at all.
  const canShowCursor = isTerminalFocused && !accessibilityEnabled;
  const invert: (text: string) => string = canShowCursor
    ? chalk.inverse
    : (text: string) => text;
  const textInputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onHistoryReset: props.onHistoryReset,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onClearInput: props.onClearInput,
    focus: props.focus,
    mask: props.mask,
    multiline: props.multiline,
    cursorChar: props.showCursor ? ' ' : '',
    highlightPastedText: props.highlightPastedText,
    invert,
    themeText: color('text', theme),
    columns: props.columns,
    maxVisibleLines: props.maxVisibleLines,
    onImagePaste: props.onImagePaste,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    inputFilter: props.inputFilter,
    inlineGhostText: props.inlineGhostText,
    dim: chalk.dim
  });
  return <Box>
      <BaseTextInput inputState={textInputState} terminalFocus={isTerminalFocused} highlights={props.highlights} invert={invert} hidePlaceholderText={false} {...props} />
    </Box>;
}

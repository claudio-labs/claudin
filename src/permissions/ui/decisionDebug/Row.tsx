import React from 'react';
import { Box, Text } from 'src/terminal/ink.js';

/** Columns before a row's value: the right-aligned label and one space. */
export const GUTTER_WIDTH = 10;

/** Every label drawn in the gutter; each must fit in it, space included. */
export const GUTTER_LABELS = ['Behavior', 'Message', 'Reason', 'Rules', 'Dirs', 'Mode'] as const;

type GutterLabel = (typeof GUTTER_LABELS)[number];

type RowProps = { label: GutterLabel; children?: React.ReactNode };

export function Row({ label, children }: RowProps): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box width={GUTTER_WIDTH - 1} flexShrink={0} justifyContent="flex-end">
        <Text>{label}</Text>
      </Box>
      <Box marginLeft={1} flexDirection="column">
        {typeof children === 'string' ? <Text>{children}</Text> : children}
      </Box>
    </Box>
  );
}

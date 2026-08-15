import React from 'react';
import Box from 'src/terminal/ink/components/Box.js';
import Text from 'src/terminal/ink/components/Text.js';

type Props = {
  readonly error: Error;
};

export default function ErrorOverview({
  error
}: Props) {
  const message = error.message || 'Unknown error';
  const stackLines = error.stack ? error.stack.split('\n').slice(1) : [];
  return <Box flexDirection="column" padding={1}>
      <Box>
        <Text backgroundColor="ansi:red" color="ansi:white">
          {' '}
          ERROR{' '}
        </Text>
        <Text> {message}</Text>
      </Box>

      {stackLines.length > 0 && <Box marginTop={1} flexDirection="column">
          {stackLines.map((line, index) => <Text key={`${index}:${line}`}>{line}</Text>)}
        </Box>}
    </Box>;
}

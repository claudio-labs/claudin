// Confirmation in front of an MCP disconnect, raised by `x` on a footer MCP row.
//
// The other footer rows kill without asking, because the process being killed is
// one this session spawned. An MCP server is not: it is the user's own
// configuration, and dropping one takes its tools out from under the model
// mid-conversation. The copy states the two things that make this different from
// the `/mcp` toggle — it lasts only for this session, and settings.json is not
// touched — because otherwise the two actions look identical from the outside.

import React, { useCallback } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { Select } from 'src/terminal/custom-select/select.js';
import { useMcpDisconnect } from 'src/mcp/MCPConnectionManager.js';
import { useSetAppState } from 'src/terminal/state/AppState.js';
import type { PendingMcpDisconnect } from 'src/terminal/state/AppStateStore.js';
import { logError } from 'src/shared/log.js';
import { errorMessage } from 'src/shared/errors.js';
import { plural } from 'src/shared/text/stringUtils.js';

type Props = {
  pending: PendingMcpDisconnect;
};

// Cancel is first so a blind Enter is the safe answer — the destructive option
// should never be the one a reflex selects.
const OPTIONS = [
  { label: 'Cancel', value: 'no' },
  { label: 'Disconnect', value: 'yes' },
];

export function McpDisconnectDialog({ pending }: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const disconnectMcpServer = useMcpDisconnect();

  const clear = useCallback(() => {
    setAppState(prev => ({ ...prev, pendingMcpDisconnect: null }));
  }, [setAppState]);

  const handleSelect = useCallback(
    (value: string) => {
      // Clear first: the disconnect awaits the transport closing, and leaving
      // the dialog up for those moments reads as a hang. The row stays — it
      // turns amber on the next snapshot, which is how the user sees that the
      // server is down rather than gone.
      clear();
      if (value === 'yes') {
        void disconnectMcpServer(pending.serverName).catch(e => {
          logError(
            new Error(
              `Failed to disconnect MCP server ${pending.serverName}: ${errorMessage(e)}`,
            ),
          );
        });
      }
    },
    [clear, disconnectMcpServer, pending.serverName],
  );

  return (
    <Dialog title={`Disconnect ${pending.serverName}?`} onCancel={clear} color="error">
      <Box marginX={2} flexDirection="column">
        <Text dimColor>
          {pending.toolCount > 0
            ? `Removes ${pending.toolCount} ${plural(pending.toolCount, 'tool')} for the rest of this session.`
            : 'Drops the connection for the rest of this session.'}
        </Text>
        <Text dimColor>
          settings.json is not changed — the server comes back on the next start,
          or now via /mcp.
        </Text>
      </Box>
      <Select onChange={handleSelect} onCancel={clear} options={OPTIONS} />
    </Dialog>
  );
}

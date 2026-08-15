import { c as _c } from "react-compiler-runtime";
/**
 * Miscellaneous subcommand handlers — extracted from main.tsx for lazy loading.
 * setup-token, doctor, install
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { cwd } from 'process';
import React from 'react';
import { WelcomeV2 } from 'src/terminal/logo/WelcomeV2.js';
import { useManagePlugins } from 'src/platform/useManagePlugins.js';
import type { Root } from 'src/terminal/ink.js';
import { Box, Text } from 'src/terminal/ink.js';
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js';
import { logEvent } from 'src/platform/analytics/index.js';
import { MCPConnectionManager } from 'src/services/mcp/MCPConnectionManager.js';
import { AppStateProvider } from 'src/terminal/state/AppState.js';
import { onChangeAppState } from 'src/terminal/state/onChangeAppState.js';
import { isAnthropicAuthEnabled } from 'src/services/auth/auth.js';
import type { CommandResultDisplay } from 'src/types/command.js';
export async function setupTokenHandler(root: Root): Promise<void> {
  logEvent('tengu_setup_token_command', {});
  const showAuthWarning = !isAnthropicAuthEnabled();
  const {
    ConsoleOAuthFlow
  } = await import('src/components/ConsoleOAuthFlow.js');
  await new Promise<void>(resolve => {
    root.render(<AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1}>
            <WelcomeV2 />
            {showAuthWarning && <Box flexDirection="column">
                <Text color="warning">
                  Warning: You already have authentication configured via
                  environment variable or API key helper.
                </Text>
                <Text color="warning">
                  The setup-token command will create a new OAuth token which
                  you can use instead.
                </Text>
              </Box>}
            <ConsoleOAuthFlow onDone={() => {
            void resolve();
          }} mode="setup-token" startingMessage="This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required." />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>);
  });
  root.unmount();
  process.exit(0);
}

// DoctorWithPlugins wrapper + doctor handler
const DoctorLazy = React.lazy(() => import('src/platform/doctor/Doctor.js').then(m => ({
  default: m.Doctor
})));
type DoctorWithPluginsProps = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
function DoctorWithPlugins(t0: DoctorWithPluginsProps) {
  const $ = _c(2);
  const {
    onDone
  } = t0;
  useManagePlugins();
  let t1;
  if ($[0] !== onDone) {
    t1 = <React.Suspense fallback={null}><DoctorLazy onDone={onDone} /></React.Suspense>;
    $[0] = onDone;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
export async function doctorHandler(root: Root): Promise<void> {
  logEvent('tengu_doctor_command', {});
  await new Promise<void>(resolve => {
    root.render(<AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
            <DoctorWithPlugins onDone={() => {
            void resolve();
          }} />
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>);
  });
  root.unmount();
  process.exit(0);
}

// install handler
export async function installHandler(target: string | undefined, options: {
  force?: boolean;
}): Promise<void> {
  const {
    setup
  } = await import('src/platform/setup.js');
  await setup(cwd(), 'default', false, false, undefined, false);
  const {
    install
  } = await import('src/commands/install.js');
  await new Promise<void>(resolve => {
    const args: string[] = [];
    if (target) args.push(target);
    if (options.force) args.push('--force');
    void install.call(result => {
      void resolve();
      process.exit(result.includes('failed') ? 1 : 0);
    }, {}, args);
  });
}

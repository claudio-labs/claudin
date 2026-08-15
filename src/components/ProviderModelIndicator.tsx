import type * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { useTheme } from 'src/terminal/design-system/ThemeProvider.js';
import { onGlobalConfigChange } from 'src/services/config/config.js';
import type { ProviderProfile } from 'src/services/config/config.js';
import { getActiveProviderProfile } from 'src/services/api/providerProfiles.js';
import { getMainLoopModel, renderModelName } from 'src/utils/model/model.js';
import { buildModelPill, buildProviderPill, resolveBranchBg } from 'src/services/git/format-branch.js';
import { getTheme } from 'src/terminal/theme/theme.js';
import { logError } from 'src/shared/log.js';
import { toError } from 'src/shared/errors.js';

type Snapshot = {
  provider: string;
  model: string;
};

export function readSnapshot(): Snapshot | null {
  let profile: ProviderProfile | undefined;
  try {
    profile = getActiveProviderProfile();
  } catch (e) {
    logError(new Error(`ProviderModelIndicator: failed to resolve active provider profile: ${toError(e).message}`));
    return null;
  }
  if (!profile) return null;
  let modelId = '';
  try {
    modelId = getMainLoopModel() || profile.model || '';
  } catch (e) {
    logError(new Error(`ProviderModelIndicator: failed to resolve main loop model, falling back to profile model: ${toError(e).message}`));
    modelId = profile.model || '';
  }
  return {
    provider: profile.name || profile.provider,
    model: modelId ? renderModelName(modelId) : '',
  };
}

function snapshotEqual(a: Snapshot | null, b: Snapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Compact provider/model Powerline pills rendered next to the session token
 * indicator. Updates in realtime via `onGlobalConfigChange` (covers `/provider`)
 * plus a light poll (covers `/model`, which only mutates in-memory state).
 */
export function ProviderModelIndicator({ nextBg }: { nextBg?: string } = {}): React.ReactNode {
  const [themeName] = useTheme();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => readSnapshot());

  useEffect(() => {
    const refresh = (): void => {
      setSnapshot(prev => {
        const next = readSnapshot();
        return snapshotEqual(prev, next) ? prev : next;
      });
    };
    const unsubscribe = onGlobalConfigChange(refresh);
    const interval = setInterval(refresh, 1500);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  if (!snapshot) return null;

  const theme = getTheme(themeName);
  // `nextBg` is the background of whatever pill follows this one (e.g. the effort
  // pill). The last segment's trailing arrow is painted over it so they connect
  // seamlessly; when undefined the arrow falls back to the terminal bg.
  const modelPill = snapshot.model ? buildModelPill(snapshot.model, theme, nextBg) : '';
  // When a model pill follows, join the provider's trailing arrow into the
  // model's background (resolveBranchBg); otherwise the provider is the last
  // segment, so its arrow joins into `nextBg`.
  const providerPill = buildProviderPill(snapshot.provider, theme, modelPill ? resolveBranchBg(theme) : nextBg);
  const combined = modelPill ? `${providerPill}${modelPill}` : providerPill;

  return (
    <Box>
      <Text wrap="truncate">{combined}</Text>
    </Box>
  );
}

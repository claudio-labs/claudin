import type * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from '../ink.js';
import { useTheme } from './design-system/ThemeProvider.js';
import { onGlobalConfigChange } from '../utils/config.js';
import type { ProviderProfile } from '../utils/config.js';
import { getActiveProviderProfile } from '../utils/providerProfiles.js';
import { getMainLoopModel } from '../utils/model/model.js';
import { buildModelPill, buildProviderPill } from '../utils/format-branch.js';
import { getTheme } from '../utils/theme.js';
import { logError } from '../utils/log.js';

type Snapshot = {
  provider: string;
  model: string;
};

function readSnapshot(): Snapshot | null {
  let profile: ProviderProfile | undefined;
  try {
    profile = getActiveProviderProfile();
  } catch (e) {
    logError('ProviderModelIndicator: failed to resolve active provider profile', e);
    return null;
  }
  if (!profile) return null;
  let modelId = '';
  try {
    modelId = getMainLoopModel() || profile.model || '';
  } catch (e) {
    logError('ProviderModelIndicator: failed to resolve main loop model, falling back to profile model', e);
    modelId = profile.model || '';
  }
  return {
    provider: profile.name || profile.provider,
    model: modelId,
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
export function ProviderModelIndicator(): React.ReactNode {
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
  const providerPill = buildProviderPill(snapshot.provider, theme);
  const modelPill = snapshot.model ? buildModelPill(snapshot.model, theme) : '';
  const combined = modelPill ? `${providerPill}${modelPill}` : providerPill;

  return (
    <Box>
      <Text wrap="truncate">{combined}</Text>
    </Box>
  );
}

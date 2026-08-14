import * as React from 'react';
import { Passes } from 'src/components/Passes/Passes.js';
import { logEvent } from 'src/services/analytics/index.js';
import { getCachedRemainingPasses } from 'src/services/api/referral.js';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
import { getGlobalConfig, saveGlobalConfig } from 'src/services/config/config.js';
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  // Mark that user has visited /passes so we stop showing the upsell
  const config = getGlobalConfig();
  const isFirstVisit = !config.hasVisitedPasses;
  if (isFirstVisit) {
    const remaining = getCachedRemainingPasses();
    saveGlobalConfig(current => ({
      ...current,
      hasVisitedPasses: true,
      passesLastSeenRemaining: remaining ?? current.passesLastSeenRemaining
    }));
  }
  logEvent('tengu_guest_passes_visited', {
    is_first_visit: isFirstVisit
  });
  return <Passes onDone={onDone} />;
}

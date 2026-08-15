import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from 'src/agent/cost-tracker.js'
import { hasConsoleBillingAccess } from 'src/services/api/billing.js'
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      if (hasConsoleBillingAccess()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }

      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}

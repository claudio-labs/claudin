import React, { Suspense, use, useCallback, useRef, useState } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import type { Message } from 'src/shared/types/message.js';
import {
  generatePermissionExplanation,
  isPermissionExplainerEnabled,
  type PermissionExplanation as PermissionExplanationType,
  type RiskLevel,
} from 'src/permissions/permissionExplainer.js';
import { ShimmerChar } from 'src/terminal/spinner/ShimmerChar.js';
import { useShimmerAnimation } from 'src/terminal/spinner/useShimmerAnimation.js';

type PermissionExplanationProps = {
  toolName: string;
  toolInput: unknown;
  toolDescription?: string;
  messages?: Message[];
};

type ExplainerState = {
  visible: boolean;
  enabled: boolean;
  promise: Promise<PermissionExplanationType | null> | null;
};

type ExplanationRequest = Promise<PermissionExplanationType | null>;

const LOADING_TEXT = 'Loading explanation…';

const RISK_LABELS: Record<RiskLevel, { text: string; color: 'success' | 'warning' | 'error' }> = {
  LOW: { text: 'Low risk', color: 'success' },
  MEDIUM: { text: 'Med risk', color: 'warning' },
  HIGH: { text: 'High risk', color: 'error' },
};

function requestExplanation(props: PermissionExplanationProps): ExplanationRequest {
  // Never aborted: a closed panel keeps its request so reopening it shows the answer.
  const { signal } = new AbortController();
  return generatePermissionExplanation({ ...props, signal });
}

/**
 * The ctrl+e toggle of a shell permission dialog. The model is asked on the
 * first open and at most once per mounted dialog. The answer is shown to the
 * user only; the dialog's decision never reads it.
 */
export function usePermissionExplainerUI(props: PermissionExplanationProps): ExplainerState {
  const [enabled] = useState(isPermissionExplainerEnabled);
  const [visible, setVisible] = useState(false);
  const [promise, setPromise] = useState<ExplanationRequest | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const request = useRef<ExplanationRequest | null>(null);

  const toggle = useCallback(() => {
    if (!request.current) {
      request.current = requestExplanation(latestProps.current);
      setPromise(request.current);
    }
    setVisible(shown => !shown);
  }, []);

  useKeybinding('confirm:toggleExplanation', toggle, { context: 'Confirmation', isActive: enabled });

  return { visible, enabled, promise };
}

function LoadingLine(): React.ReactNode {
  const [ref, glimmerIndex] = useShimmerAnimation('requesting', LOADING_TEXT, false);
  return (
    <Box ref={ref}>
      <Text>
        {[...LOADING_TEXT].map((char, index) => (
          <ShimmerChar key={index} char={char} index={index} glimmerIndex={glimmerIndex} messageColor="inactive" shimmerColor="text" />
        ))}
      </Text>
    </Box>
  );
}

function RiskLine({ level, risk }: { level: RiskLevel; risk: string }): React.ReactNode {
  const label = RISK_LABELS[level];
  return (
    <Text>
      <Text color={label.color}>{label.text}:</Text> {risk}
    </Text>
  );
}

function ExplanationResult({ promise }: { promise: ExplanationRequest }): React.ReactNode {
  const explanation = use(promise);
  if (!explanation) return <Text dimColor>Explanation unavailable</Text>;
  return (
    <Box flexDirection="column">
      <Text>{explanation.explanation}</Text>
      <Box marginTop={1}>
        <Text>{explanation.reasoning}</Text>
      </Box>
      <Box marginTop={1}>
        <RiskLine level={explanation.riskLevel} risk={explanation.risk} />
      </Box>
    </Box>
  );
}

export function PermissionExplainerContent({ visible, promise }: Pick<ExplainerState, 'visible' | 'promise'>): React.ReactNode {
  if (!visible || !promise) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Suspense fallback={<LoadingLine />}>
        <ExplanationResult promise={promise} />
      </Suspense>
    </Box>
  );
}

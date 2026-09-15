import { c as _c } from "react-compiler-runtime";
import { Box, Link, Newline, Text } from 'src/terminal/ink.js';
import { gracefulShutdownSync } from 'src/shared/proc/gracefulShutdown.js';
import { updateSettingsForSource } from 'src/platform/settings/settings.js';
import { Select } from 'src/terminal/custom-select/index.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
type Props = {
  onAccept(): void;
};
export function BypassPermissionsModeDialog(t0: Props) {
  const $ = _c(7);
  const {
    onAccept
  } = t0;
  // Slot $[0] held the removed mount-effect's dep array (analytics only). It
  // stays allocated so _c(7) and every later $[i] keep their numbering.
  let t2;
  if ($[1] !== onAccept) {
    t2 = function onChange(value: 'accept' | 'decline') {
      bb3: switch (value) {
        case "accept":
          {
            updateSettingsForSource("userSettings", {
              skipDangerousModePermissionPrompt: true
            });
            onAccept();
            break bb3;
          }
        case "decline":
          {
            gracefulShutdownSync(1);
          }
      }
    };
    $[1] = onAccept;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const onChange = t2;
  const handleEscape = _temp2;
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column" gap={1}><Text>In Bypass Permissions mode, Claudin will not ask for your approval before running potentially dangerous commands.<Newline />This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.</Text><Text>By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.</Text><Link url="https://code.claude.com/docs/en/security" /></Box>;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  let t4;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [{
      label: "No, exit",
      value: "decline"
    }, {
      label: "Yes, I accept",
      value: "accept"
    }];
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] !== onChange) {
    t5 = <Dialog title="WARNING: Claudin running in Bypass Permissions mode" color="error" onCancel={handleEscape}>{t3}<Select options={t4} onChange={(value_0: string) => onChange(value_0 as 'accept' | 'decline')} /></Dialog>;
    $[5] = onChange;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  return t5;
}
function _temp2() {
  gracefulShutdownSync(0);
}

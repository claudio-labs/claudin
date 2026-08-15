import type { Notification } from 'src/terminal/contexts/notifications.js';
import { checkInstall } from 'src/services/install/index.js';
import { useStartupNotification } from 'src/hooks/notifs/useStartupNotification.js';
// The barrel (src/services/install/index.js) deliberately re-exports
// only the functions external modules use, not the SetupMessage type —
// derive the element type from checkInstall's own return type instead.
type SetupMessage = Awaited<ReturnType<typeof checkInstall>>[number];
export function useInstallMessages() {
  useStartupNotification(_temp2);
}
async function _temp2(): Promise<Notification[]> {
  const messages = await checkInstall();
  return messages.map(_temp);
}
function _temp(message: SetupMessage, index: number): Notification {
  let priority: Notification['priority'] = "low";
  if (message.type === "error" || message.userActionRequired) {
    priority = "high";
  } else {
    if (message.type === "path" || message.type === "alias") {
      priority = "medium";
    }
  }
  return {
    key: `install-message-${index}-${message.type}`,
    text: message.message,
    priority,
    color: message.type === "error" ? "error" : "warning"
  };
}

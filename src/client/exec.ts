import { createExec } from "@mgcrea/mcp-ios-core";

import { TIMEOUT_REMEDY, TOOLCHAIN_REMEDY } from "#/client/errors";

export { assertNoShellMetachars } from "@mgcrea/mcp-ios-core";
export type { ExecImpl, ExecResult, Logger } from "@mgcrea/mcp-ios-core";

/**
 * devicectl reports the interesting failures in prose, and each has a different
 * fix. Saying which one it is here is the difference between one retry and five.
 *
 * This is the half of the process boundary that cannot be shared: every string
 * below describes something only a physical phone has — a lock screen, Developer
 * Mode, a provisioning profile listing the device's UDID.
 */
const remedyFor = (stderr: string): string | undefined => {
  const text = stderr.toLowerCase();
  if (text.includes("device is locked") || text.includes("passcode")) {
    return "Unlock the device and retry — devicectl cannot install or launch onto a locked screen.";
  }
  if (text.includes("developer mode")) {
    return "Enable Developer Mode on the device: Settings > Privacy & Security > Developer Mode.";
  }
  if (text.includes("could not find") && text.includes("device")) {
    return "Run ios_device_list_devices to see what is actually connected, and pass its identifier.";
  }
  if (text.includes("no code signature") || text.includes("provisioning")) {
    return "The app is not signed for this device. Rebuild with a development profile that includes the device's UDID.";
  }
  if (text.includes("not installed") || text.includes("no such application")) {
    return "Install the app first with ios_device_install, or check the bundle id with ios_device_list_apps.";
  }
  return undefined;
};

export const defaultExec = createExec({
  timeout: TIMEOUT_REMEDY,
  toolchain: TOOLCHAIN_REMEDY,
  remedyFor,
});

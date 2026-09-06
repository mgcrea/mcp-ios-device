/**
 * The device server's error surface: the shared taxonomy from `#/core/errors`,
 * plus the copy that only makes sense for a physical phone.
 *
 * The split is the words, not the classes. A simulator times out, misses the
 * toolchain and loses its WebDriverAgent in exactly the same shapes; what
 * differs is that none of the fixes below — unlock the screen, enable Developer
 * Mode, trust the runner — exists there. So the classes are shared and the
 * remedies are handed in from here.
 */
export {
  CommandError,
  CommandTimeoutError,
  ToolchainError,
  WdaError,
  WdaUnavailableError,
} from "@mgcrea/mcp-ios-core";
export {
  /**
   * The base class, under the name it has always had here. An **alias**, not a
   * subclass: `WdaError` and `CommandError` extend `IosError`, so making this a
   * subclass would quietly stop `instanceof IosDeviceError` from matching them.
   */
  IosError as IosDeviceError,
} from "@mgcrea/mcp-ios-core";

import { IosError } from "@mgcrea/mcp-ios-core";

/** Raising the budget, or noticing the device went away mid-call. */
export const TIMEOUT_REMEDY =
  "Raise IOS_DEVICE_TIMEOUT_MS if this is a slow operation (a large `install` genuinely " +
  "takes minutes), or check that the device is still connected and unlocked.";

/** Xcode's command line tools are not where we expected them. */
export const TOOLCHAIN_REMEDY =
  "Install Xcode and run `xcode-select --install`, or point IOS_DEVICE_XCRUN_PATH at a " +
  "different xcrun.";

/**
 * How to get the runner up, and how to get it authorized. Two separate things,
 * so two separate strings.
 *
 * Shared rather than written per site: three failures lead to the same advice —
 * the runner not answering, the runner answering but refusing every XCTest
 * action, and `ios_device_diagnostics` reporting either — and hand-written
 * copies of a remedy this long drift apart the first time one is corrected.
 */
export const START_RUNNER_SCRIPT_REMEDY =
  "Start the runner with `scripts/wda.sh run` (or `npx -p @mgcrea/mcp-ios-device ios-device-wda run` " +
  "from an npm install) and leave it open — the HTTP server is the XCTest process, so it stops " +
  "when that command does.";

/**
 * The same thing, done with this server's own tool.
 *
 * It matters more here than the wording suggests. The automation grant is given
 * to an XCTest session when it starts and never revisited, so a runner that came
 * up unauthorized stays unauthorized however many times the Settings toggle is
 * flipped — restarting it is not one fix among several, it is the only one. A
 * remedy that sends the reader to a terminal for it is sending them away from
 * the single tool that does the job.
 */
export const START_RUNNER_TOOL_REMEDY =
  "Restart it with ios_device_restart_wda, which stops any runner already driving this device " +
  "and spawns a fresh one detached, so it outlives this conversation. It returns as soon as the " +
  "runner is spawned; poll ios_device_diagnostics for `wda.authorized` rather than waiting. The " +
  "runner has to have been built once first, with `scripts/wda.sh setup`.";

/**
 * How to get the runner up, in whichever way the caller can actually reach.
 *
 * `ios_device_restart_wda` is registered only when writes are on — and unlike
 * the simulator server, writes here default to **off**, so the script recipe is
 * what most sessions will be given. Naming a tool that is not in the list would
 * be the same mistake this replaces, pointed the other way.
 */
export const startRunnerRemedy = (allowWrites: boolean): string =>
  allowWrites ? START_RUNNER_TOOL_REMEDY : START_RUNNER_SCRIPT_REMEDY;

/**
 * The one remedy nobody can apply from this Mac. It is a separate toggle from
 * Developer Mode, which is why a device that passes every other check here can
 * still refuse to be driven.
 */
export const UI_AUTOMATION_REMEDY =
  "Turn on Settings > Developer > Enable UI Automation on the device. It is a separate toggle " +
  "from Developer Mode, cannot be set from this Mac, and is the usual cause.";

/** What to do when WebDriverAgent does not answer at all. */
export const wdaUnavailableRemedy = (allowWrites: boolean): string =>
  `${startRunnerRemedy(allowWrites)} If it starts and then fails with "Timed out while enabling ` +
  `automation mode", the device is refusing the automation grant: ${UI_AUTOMATION_REMEDY} ` +
  "If you forward port 8100 yourself, set IOS_DEVICE_WDA_URL instead.";

/** No device matched, or several did and none was named. */
export class DeviceNotFoundError extends IosError {
  override readonly name = "DeviceNotFoundError";

  constructor(message: string, remedy: string) {
    super(message, { remedy });
  }
}

/** Thrown when a write path is reached while IOS_DEVICE_ALLOW_WRITES is off. */
export class WritesDisabledError extends IosError {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} drives or changes the device, but writes are disabled. ` +
        `Set IOS_DEVICE_ALLOW_WRITES=1 to enable the tools that touch the screen.`,
    );
  }
}

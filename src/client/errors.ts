/**
 * One class per failure mode, and each carries the remedy separately from the
 * message. The message says what happened; the remedy is the half a model should
 * act on, and `fail()` lifts it to a top-level field rather than burying it.
 */
export class IosDeviceError extends Error {
  override readonly name: string = "IosDeviceError";
  readonly remedy: string | undefined;
  readonly details: unknown;

  constructor(message: string, opts: { remedy?: string; details?: unknown } = {}) {
    super(message);
    this.remedy = opts.remedy;
    this.details = opts.details;
  }
}

/** A `xcrun devicectl` / `sips` invocation exited non-zero. */
export class CommandError extends IosDeviceError {
  override readonly name = "CommandError";
  readonly command: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    opts: { command: string; exitCode: number | null; remedy?: string; details?: unknown },
  ) {
    super(message, opts);
    this.command = opts.command;
    this.exitCode = opts.exitCode;
  }
}

/** The child process outlived its budget and was killed. */
export class CommandTimeoutError extends IosDeviceError {
  override readonly name = "CommandTimeoutError";

  constructor(command: string, timeoutMs: number) {
    super(`\`${command}\` did not finish within ${timeoutMs}ms and was killed.`, {
      remedy:
        "Raise IOS_DEVICE_TIMEOUT_MS if this is a slow operation (a large `install` genuinely " +
        "takes minutes), or check that the device is still connected and unlocked.",
    });
  }
}

/** Xcode's command line tools are not where we expected them. */
export class ToolchainError extends IosDeviceError {
  override readonly name = "ToolchainError";

  constructor(path: string) {
    super(`${path} not found — this server only runs on macOS with Xcode installed.`, {
      remedy:
        "Install Xcode and run `xcode-select --install`, or point IOS_DEVICE_XCRUN_PATH at a " +
        "different xcrun.",
    });
  }
}

/** No device matched, or several did and none was named. */
export class DeviceNotFoundError extends IosDeviceError {
  override readonly name = "DeviceNotFoundError";

  constructor(message: string, remedy: string) {
    super(message, { remedy });
  }
}

/**
 * How to get the runner up, and how to get it authorized. Two separate things,
 * so two separate strings.
 *
 * Shared rather than written per site: three failures lead to the same advice —
 * the runner not answering, the runner answering but refusing every XCTest
 * action, and `ios_device_diagnostics` reporting either — and hand-written
 * copies of a remedy this long drift apart the first time one is corrected.
 */
export const START_RUNNER_REMEDY =
  "Start the runner with `scripts/wda.sh run` (or `npx -p @mgcrea/mcp-ios-device ios-device-wda run` " +
  "from an npm install) and leave it open — the HTTP server is the XCTest process, so it stops " +
  "when that command does.";

/**
 * The one remedy nobody can apply from this Mac. It is a separate toggle from
 * Developer Mode, which is why a device that passes every other check here can
 * still refuse to be driven.
 */
export const UI_AUTOMATION_REMEDY =
  "Turn on Settings > Developer > Enable UI Automation on the device. It is a separate toggle " +
  "from Developer Mode, cannot be set from this Mac, and is the usual cause.";

/**
 * WebDriverAgent is not answering. Distinguished from every other failure
 * because the fix is entirely different — nothing is wrong with the device, the
 * runner just is not up.
 */
export class WdaUnavailableError extends IosDeviceError {
  override readonly name = "WdaUnavailableError";

  constructor(url: string, cause: string) {
    super(`WebDriverAgent is not reachable at ${url} (${cause}).`, {
      remedy:
        `${START_RUNNER_REMEDY} If it starts and then fails with "Timed out while enabling ` +
        `automation mode", the device is refusing the automation grant: ${UI_AUTOMATION_REMEDY} ` +
        "If you forward port 8100 yourself, set IOS_DEVICE_WDA_URL instead.",
    });
  }
}

/** WebDriverAgent answered, but with an error. */
export class WdaError extends IosDeviceError {
  override readonly name = "WdaError";
  readonly status: number;
  readonly wdaCode: string | undefined;

  constructor(
    message: string,
    opts: { status: number; wdaCode?: string; remedy?: string; details?: unknown },
  ) {
    super(message, opts);
    this.status = opts.status;
    this.wdaCode = opts.wdaCode;
  }
}

/** Thrown when a write path is reached while IOS_DEVICE_ALLOW_WRITES is off. */
export class WritesDisabledError extends IosDeviceError {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} drives or changes the device, but writes are disabled. ` +
        `Set IOS_DEVICE_ALLOW_WRITES=1 to enable the tools that touch the screen.`,
    );
  }
}

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
 * WebDriverAgent is not answering. Distinguished from every other failure
 * because the fix is entirely different — nothing is wrong with the device, the
 * runner just is not up.
 */
export class WdaUnavailableError extends IosDeviceError {
  override readonly name = "WdaUnavailableError";

  constructor(url: string, cause: string) {
    super(`WebDriverAgent is not reachable at ${url} (${cause}).`, {
      remedy:
        "Start the runner with `scripts/wda.sh run` and leave it open — the HTTP server is the " +
        "XCTest process, so it stops when that command does. If it starts and then fails with " +
        '"Timed out while enabling automation mode", the device needs Settings > Developer > ' +
        "Enable UI Automation turned on: it is a separate toggle from Developer Mode and is the " +
        "one people miss. If you forward port 8100 yourself, set IOS_DEVICE_WDA_URL instead.",
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

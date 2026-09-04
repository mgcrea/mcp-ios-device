import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DisplayInfo } from "@mgcrea/mcp-ios-core";

import { CommandError, IosDeviceError } from "#/client/errors";
import { assertNoShellMetachars, defaultExec, type ExecImpl, type Logger } from "#/client/exec";

/**
 * `xcrun devicectl` — Apple's own device tool, and the half of this server that
 * needs nothing installed on the phone.
 *
 * Two things shape every method here.
 *
 * First, devicectl says so itself: "JSON output to a user-provided file on disk
 * is the ONLY supported interface for scripts/programs to consume command
 * output." Its stdout is a human table that changes between Xcode releases, so
 * every call writes `--json-output` to a temp file and reads it back.
 *
 * Second, devicectl covers *lifecycle*, not the screen. It has no screenshot, no
 * UI tree and no touch injection — the full subcommand tree was enumerated on
 * Xcode 26.6 and `strings` over the binary finds no such symbols. Everything
 * that sees or touches the screen lives in `#/client/wda` instead.
 */
export type DevicectlOptions = {
  xcrunPath: string;
  timeoutMs: number;
  exec?: ExecImpl | undefined;
  logger?: Logger | undefined;
};

export type RawDevice = {
  identifier: string;
  connectionProperties?: {
    pairingState?: string;
    tunnelState?: string;
    tunnelIPAddress?: string;
    transportType?: string;
    lastConnectionDate?: string;
  };
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
    osBuildUpdate?: string;
    developerModeStatus?: string;
    ddiServicesAvailable?: boolean;
    bootState?: string;
  };
  hardwareProperties?: {
    udid?: string;
    marketingName?: string;
    productType?: string;
    platform?: string;
    deviceType?: string;
    reality?: string;
  };
};

export type RawDisplay = {
  displayId?: number;
  primary?: boolean;
  nativeSize?: [number, number];
  bounds?: [[number, number], [number, number]];
  pointScale?: number;
  currentOrientation?: string;
};

export type RawApp = {
  bundleIdentifier?: string;
  name?: string;
  version?: string;
  bundleVersion?: string;
  builtByDeveloper?: boolean;
  appClip?: boolean;
  removable?: boolean;
  defaultApp?: boolean;
  /** `file:///private/var/containers/Bundle/Application/<uuid>/Foo.app/` — the only reliable way back to a pid. */
  url?: string;
};

export type RawProcess = { processIdentifier?: number; executable?: string };

type Envelope = { info?: unknown; result?: unknown; error?: unknown };

export class Devicectl {
  private readonly xcrunPath: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecImpl;
  private readonly logger: Logger | undefined;

  constructor(opts: DevicectlOptions) {
    this.xcrunPath = opts.xcrunPath;
    this.timeoutMs = opts.timeoutMs;
    this.exec = opts.exec ?? defaultExec;
    this.logger = opts.logger;
  }

  /**
   * Run one devicectl subcommand and return the parsed `result` object.
   *
   * The temp directory is created per call rather than reused: two tools can run
   * concurrently, and a shared `--json-output` path would have one read the
   * other's answer with nothing at all looking wrong.
   */
  private async run(
    args: string[],
    trailing: string[] = [],
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const dir = await mkdtemp(join(tmpdir(), "devicectl-"));
    const jsonPath = join(dir, "out.json");
    // `--quiet` and `--json-output` go BEFORE `trailing`, never after. The one
    // subcommand with a trailing argument array is `process launch`, whose
    // `<command-line-arguments>` swallow everything that follows the bundle id —
    // so appending our own flags there would either hand them to the app or,
    // worse, have them parsed as ours and silently dropped from the app's argv.
    const argv = ["devicectl", ...args, "--quiet", "--json-output", jsonPath, ...trailing];
    this.logger?.debug?.("devicectl", args.join(" "));
    try {
      await this.exec(this.xcrunPath, argv, timeoutMs);
      return await this.readEnvelope(jsonPath, args);
    } catch (err) {
      // devicectl still writes the envelope on failure, and its `error.userInfo`
      // is far more specific than the stderr line — "The developer disk image
      // could not be mounted" rather than "operation failed".
      const detail = await this.readErrorDetail(jsonPath);
      if (detail && err instanceof CommandError) {
        throw new CommandError(`${err.message} — ${detail}`, {
          command: err.command,
          exitCode: err.exitCode,
          ...(err.remedy ? { remedy: err.remedy } : {}),
          details: err.details,
        });
      }
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async readEnvelope(jsonPath: string, args: string[]): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(jsonPath, "utf8");
    } catch {
      throw new IosDeviceError(`devicectl ${args.join(" ")} produced no JSON output.`, {
        remedy: "Check that Xcode's command line tools are installed and the device is connected.",
      });
    }
    const envelope = JSON.parse(raw) as Envelope;
    return envelope.result;
  }

  private async readErrorDetail(jsonPath: string): Promise<string | undefined> {
    try {
      const envelope = JSON.parse(await readFile(jsonPath, "utf8")) as Envelope;
      const error = envelope.error as
        | { userInfo?: { NSLocalizedDescription?: { string?: string } }; description?: string }
        | undefined;
      return error?.userInfo?.NSLocalizedDescription?.string ?? error?.description;
    } catch {
      return undefined;
    }
  }

  async listDevices(): Promise<RawDevice[]> {
    const result = this.run(["list", "devices"]);
    const devices = (await result) as { devices?: RawDevice[] } | undefined;
    return devices?.devices ?? [];
  }

  async displays(device: string): Promise<DisplayInfo> {
    const result = (await this.run(["device", "info", "displays", "--device", device])) as
      | {
          displays?: RawDisplay[];
          orientation?: { currentDeviceOrientation?: string };
          backlightState?: string;
        }
      | undefined;
    const display = result?.displays?.find((d) => d.primary) ?? result?.displays?.[0];
    if (!display?.nativeSize) {
      throw new IosDeviceError("The device reported no display geometry.", {
        remedy: "Wake the device and retry; a display asleep since boot can report nothing.",
      });
    }
    const [pixelWidth, pixelHeight] = display.nativeSize;
    // Round rather than trust the division: pointScale is an integer on every
    // shipping device, but a fractional point size would silently put every
    // subsequent tap half a pixel off.
    const pointScale = display.pointScale ?? 1;
    return {
      pixelWidth,
      pixelHeight,
      pointWidth: Math.round(pixelWidth / pointScale),
      pointHeight: Math.round(pixelHeight / pointScale),
      pointScale,
      orientation:
        result?.orientation?.currentDeviceOrientation ?? display.currentOrientation ?? "unknown",
      backlightState: result?.backlightState,
    };
  }

  /**
   * `passcodeRequired` is the field that matters: a locked device refuses every
   * install, every launch, and captures a black screenshot. It is the cheapest
   * check available and the most common cause of an inexplicable failure.
   */
  async lockState(
    device: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ passcodeRequired?: boolean; unlockedSinceBoot?: boolean }> {
    return (await this.run(
      ["device", "info", "lockState", "--device", device],
      [],
      opts.timeoutMs,
    )) as {
      passcodeRequired?: boolean;
      unlockedSinceBoot?: boolean;
    };
  }

  async listApps(device: string, opts: { includeAll?: boolean } = {}): Promise<RawApp[]> {
    const result = (await this.run([
      "device",
      "info",
      "apps",
      "--device",
      device,
      ...(opts.includeAll ? ["--include-all-apps"] : []),
    ])) as { apps?: RawApp[] } | undefined;
    return result?.apps ?? [];
  }

  async listProcesses(device: string): Promise<RawProcess[]> {
    const result = (await this.run(["device", "info", "processes", "--device", device])) as
      | { runningProcesses?: RawProcess[] }
      | undefined;
    return result?.runningProcesses ?? [];
  }

  async install(device: string, appPath: string): Promise<unknown> {
    assertNoShellMetachars("app path", appPath);
    return this.run(["device", "install", "app", "--device", device, appPath]);
  }

  async launch(
    device: string,
    bundleId: string,
    opts: { args?: string[]; env?: Record<string, string>; terminateExisting?: boolean } = {},
  ): Promise<{ processIdentifier?: number } | undefined> {
    const result = (await this.run(
      [
        "device",
        "process",
        "launch",
        "--device",
        device,
        ...(opts.terminateExisting === false ? [] : ["--terminate-existing"]),
        ...(opts.env && Object.keys(opts.env).length > 0
          ? ["--environment-variables", JSON.stringify(opts.env)]
          : []),
      ],
      // Everything from the bundle id on is positional: the id itself, then argv
      // for the app. These are never interpolated anywhere — each is its own
      // argv entry, so a value with a space or a semicolon in it is data.
      [bundleId, ...(opts.args ?? [])],
    )) as { process?: { processIdentifier?: number } } | undefined;
    return result?.process;
  }

  async terminate(device: string, pid: number, opts: { kill?: boolean } = {}): Promise<unknown> {
    return this.run([
      "device",
      "process",
      "terminate",
      "--device",
      device,
      "--pid",
      String(pid),
      ...(opts.kill ? ["--kill"] : []),
    ]);
  }

  async copyFrom(
    device: string,
    opts: { bundleId: string; source: string; destination: string },
  ): Promise<unknown> {
    assertNoShellMetachars("destination", opts.destination);
    assertNoShellMetachars("source", opts.source);
    return this.run([
      "device",
      "copy",
      "from",
      "--device",
      device,
      "--domain-type",
      "appDataContainer",
      "--domain-identifier",
      opts.bundleId,
      "--source",
      opts.source,
      "--destination",
      opts.destination,
    ]);
  }
}

export type { DisplayInfo } from "@mgcrea/mcp-ios-core";

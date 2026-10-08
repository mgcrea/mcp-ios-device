import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { IosDeviceError } from "#/client/errors";

/**
 * An app's console, captured through `devicectl device process launch --console`.
 *
 * This is the only way to an app's logs on a physical device that needs no
 * root. `log collect --device` and `log stream` against a device both need
 * sudo, and libimobiledevice's syslog relay is a third-party install. The
 * console path needs nothing beyond Xcode, and was measured on iOS 27.0 to
 * carry three things into devicectl's own stdout and stderr:
 *
 * - the app's stdout (`print`) and stderr;
 * - every `Logger` / `os_log` message the process emits, its frameworks'
 *   included, **but only with `OS_ACTIVITY_DT_MODE` set** in the app's
 *   environment. That is the variable Xcode sets to mirror unified logging onto
 *   stderr. With it, a React Native app sent more than 1,700 lines in eight
 *   seconds, its frameworks' subsystems included.
 *
 * Two behaviours shape everything below, and neither is obvious from `--help`:
 *
 * 1. `--console` blocks until the app exits, so the capture is a child process
 *    that outlives the tool call that started it. It ends by itself when the
 *    app is terminated.
 * 2. "Catchable signals sent to devicectl are forwarded to the app." SIGTERM or
 *    SIGINT to stop a capture would kill the app being watched. SIGKILL cannot
 *    be forwarded, and was measured to leave the app running — so that is the
 *    only signal this module ever sends.
 */

/** What the spawn seam hands back: enough to watch the capture and stop it. */
export type ConsoleProcess = {
  pid: number | undefined;
  /** Resolves with the exit code (null when killed by a signal) once devicectl exits. */
  exited: Promise<number | null>;
  /** SIGKILL, never a catchable signal — see the module comment. */
  kill: () => void;
};

/**
 * Starting the capture, as a seam. Tests substitute it so no devicectl runs,
 * while the argv, the log file and the reader all still run for real.
 */
export type SpawnConsole = (
  command: string,
  args: string[],
  opts: { logPath: string },
) => Promise<ConsoleProcess>;

/**
 * Detached and unref'd, though a capture is meaningless without this server.
 * Both are about signals and lifetime, not about outliving anything:
 *
 * - In this server's process group, a Ctrl-C in the terminal running it would
 *   reach devicectl too, which forwards it — and kills the app being watched.
 * - A referenced child keeps Node's event loop alive, so a server whose client
 *   disconnected would linger for as long as the app kept running.
 *
 * Dying with the server is `ConsoleCaptures.stopAll`, which `cli.ts` runs on exit.
 */
export const defaultSpawnConsole: SpawnConsole = async (command, args, { logPath }) => {
  const log = await open(logPath, "a");
  try {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
    child.unref();
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      // A failure to launch arrives here, not as a throw. Unhandled it would
      // take the whole server down after this function had reported success.
      child.once("error", () => resolve(-1));
    });
    return {
      pid: child.pid,
      exited,
      kill: () => {
        child.kill("SIGKILL");
      },
    };
  } finally {
    // The child holds its own copy of the descriptor.
    await log.close();
  }
};

export type Capture = {
  device: string;
  deviceName: string | undefined;
  bundleId: string;
  path: string;
  startedAt: string;
  process: ConsoleProcess;
  /** Set once devicectl exits, which is when the app did. */
  exitCode?: number | null;
};

export type ReadOptions = {
  /** Byte offset returned as `next` by the previous read; 0 or absent reads from the start. */
  cursor?: number | undefined;
  /** Case-insensitive regular expression a line must match. */
  filter?: string | undefined;
  /** Most matching lines to return; the newest are kept. */
  limit: number;
};

/**
 * One read never looks at more than this much of the file. The capture grows
 * at ~200 lines a second for a chatty app, and a read that started from 0 an
 * hour in would otherwise load tens of megabytes to return its last 200 lines.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 500;

/**
 * `2026-10-08 22:09:45.583026+0200 SandboxApp[13938:5106663] message` is how
 * the mirrored unified log prints, and the date, the zone, the process name and
 * both ids are identical on every line of a capture of one app. Cutting them to
 * `22:09:45.583 message` halves a typical line.
 */
const XCODE_PREFIX = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\d*[+-]\d{4} \S+\[\d+:\d+\] /;

const compactLine = (line: string): string => {
  const short = line.replace(XCODE_PREFIX, "$1 ");
  return short.length > MAX_LINE_CHARS ? `${short.slice(0, MAX_LINE_CHARS)}…` : short;
};

export class ConsoleCaptures {
  private readonly captures = new Map<string, Capture>();
  private latest: Capture | undefined;

  constructor(private readonly opts: { xcrunPath: string; spawn?: SpawnConsole | undefined }) {}

  private key(device: string, bundleId: string): string {
    return `${device}\u0000${bundleId}`;
  }

  /**
   * Launch `bundleId` with its console attached and captured to a file, and
   * wait until devicectl says the app is up — or has failed to start, which
   * arrives as devicectl exiting with the reason in the file.
   */
  async launch(opts: {
    device: string;
    deviceName: string | undefined;
    bundleId: string;
    args: string[];
    env: Record<string, string>;
    terminateExisting: boolean;
    outputDir: string;
    startTimeoutMs: number;
  }): Promise<Capture> {
    const key = this.key(opts.device, opts.bundleId);
    // A previous capture of the same app is replaced, never kept alongside:
    // two files filling with the same lines is a state where a reader picks
    // whichever it was handed and silently misses half of what happened.
    this.captures.get(key)?.process.kill();

    const dir = join(opts.outputDir, "logs");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = join(dir, `${opts.bundleId}-${stamp}.log`);

    const argv = [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      opts.device,
      "--console",
      ...(opts.terminateExisting ? ["--terminate-existing"] : []),
      "--environment-variables",
      // Set under the caller's own variables, so an explicit
      // OS_ACTIVITY_DT_MODE in `environment` still wins.
      JSON.stringify({ OS_ACTIVITY_DT_MODE: "YES", ...opts.env }),
      // Positional from here on, exactly as in `Devicectl.launch`: the bundle
      // id, then the app's own argv, each its own entry and never interpolated.
      opts.bundleId,
      ...opts.args,
    ];
    const child = await (this.opts.spawn ?? defaultSpawnConsole)(this.opts.xcrunPath, argv, {
      logPath: path,
    });

    const capture: Capture = {
      device: opts.device,
      deviceName: opts.deviceName,
      bundleId: opts.bundleId,
      path,
      startedAt: new Date().toISOString(),
      process: child,
    };
    void child.exited.then((code) => {
      capture.exitCode = code;
    });

    await this.waitForLaunch(capture, opts.startTimeoutMs);

    this.captures.set(key, capture);
    this.latest = capture;
    return capture;
  }

  /**
   * devicectl prints "Launched application with <id> bundle identifier." once
   * the app is running, then blocks. An exit before that line is a failed
   * launch — a locked phone, a missing app — and the reason is in the file.
   */
  private async waitForLaunch(capture: Capture, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await readFile(capture.path, "utf8").catch(() => "");
      if (/Launched application with/.test(text)) return;
      if (!this.running(capture)) {
        throw new IosDeviceError(
          `devicectl exited before ${capture.bundleId} launched: ${text.trim().split("\n").slice(-5).join(" ") || "no output"}`,
          {
            remedy:
              "Unlock the device, and check the bundle id with ios_device_list_apps. The full " +
              `output is in ${capture.path}.`,
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Not fatal: a slow launch over Wi-Fi can outlast the wait while the
    // capture itself is fine. Said in the result instead of thrown.
  }

  find(device: string | undefined, bundleId: string | undefined): Capture | undefined {
    if (device && bundleId) return this.captures.get(this.key(device, bundleId));
    const all = [...this.captures.values()].filter(
      (c) => (!device || c.device === device) && (!bundleId || c.bundleId === bundleId),
    );
    if (all.length === 0) return undefined;
    // Newest wins when the filter leaves more than one.
    return all.includes(this.latest as Capture)
      ? this.latest
      : all.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  running(capture: Capture): boolean {
    return !("exitCode" in capture);
  }

  /**
   * Read what the capture has gathered since `cursor`.
   *
   * The cursor is a byte offset, not a line number, so a read costs the same
   * an hour into a capture as it does a second in. It only ever advances to the
   * end of the last complete line: a line still being written is left for the
   * next read rather than returned in two halves.
   */
  async read(
    capture: Capture,
    opts: ReadOptions,
  ): Promise<{
    lines: string[];
    matched: number;
    omitted: number;
    next: number;
    skippedBytes: number;
  }> {
    let pattern: RegExp | undefined;
    if (opts.filter) {
      try {
        pattern = new RegExp(opts.filter, "i");
      } catch (err) {
        throw new IosDeviceError(`\`filter\` is not a valid regular expression: ${String(err)}`, {
          remedy: "Escape regex characters, e.g. `\\[Sync\\]`, or pass a plain word.",
        });
      }
    }

    const size = (await stat(capture.path)).size;
    let start = Math.min(Math.max(opts.cursor ?? 0, 0), size);
    let skippedBytes = 0;
    if (size - start > MAX_READ_BYTES) {
      skippedBytes = size - MAX_READ_BYTES - start;
      start = size - MAX_READ_BYTES;
    }

    const handle = await open(capture.path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    // Stop at the last newline while the capture runs; once it has ended
    // nothing more is coming, so a final unterminated line is complete.
    const end = this.running(capture) ? text.lastIndexOf("\n") + 1 : text.length;
    const next = start + Buffer.byteLength(text.slice(0, end), "utf8");
    let lines = text.slice(0, end).split("\n");
    if (skippedBytes > 0) lines = lines.slice(1); // started mid-line
    lines = lines.filter((line) => line.length > 0);

    const matching = pattern ? lines.filter((line) => pattern.test(line)) : lines;
    const kept = matching.slice(-opts.limit);
    return {
      lines: kept.map(compactLine),
      matched: matching.length,
      omitted: matching.length - kept.length,
      next,
      skippedBytes,
    };
  }

  /** Stop every capture without touching the apps. */
  stopAll(): void {
    for (const capture of this.captures.values()) capture.process.kill();
  }
}

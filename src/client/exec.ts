import { execFile } from "node:child_process";

import { CommandError, CommandTimeoutError, ToolchainError } from "#/client/errors";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type ExecResult = { stdout: string; stderr: string };

/**
 * The process boundary, as a seam. Tests substitute this so that everything
 * above it — argv construction, JSON envelope handling, error mapping — still
 * runs for real; mocking the devicectl wrapper itself would skip exactly the
 * code those guarantees live in.
 */
export type ExecImpl = (path: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

// devicectl's own `--json-output` files are small, but `sips` and a base64
// screenshot are not. 64 MiB is well clear of a 1320x2868 PNG.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `execFile`, never `exec` — there is no shell, so there is no quoting question
 * to get wrong. Every caller-supplied value (a bundle id, a device name, a file
 * path) arrives as its own argv entry and is therefore data, not syntax. There
 * is no code path in this server where a command is built by interpolating a
 * string, and `assertNoShellMetachars` below is the tripwire that keeps it so.
 */
export const defaultExec: ExecImpl = (path, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      path,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        killSignal: "SIGKILL",
        encoding: "utf8",
        // Inherit nothing but a PATH. xcrun resolves DEVELOPER_DIR from the
        // active toolchain on its own, and a minimal environment removes any
        // question of a stray locale or SDK override changing the output shape.
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (e.killed) {
          reject(new CommandTimeoutError(`${path} ${args[0] ?? ""}`.trim(), timeoutMs));
          return;
        }
        if (e.code === "ENOENT") {
          reject(new ToolchainError(path));
          return;
        }
        reject(
          new CommandError(describeFailure(path, args, stderr, stdout), {
            command: `${path} ${args.join(" ")}`,
            exitCode: typeof e.code === "number" ? e.code : null,
            ...(remedyFor(stderr) ? { remedy: remedyFor(stderr) } : {}),
            details: (stderr || stdout).trim().slice(0, 2000),
          }),
        );
      },
    );
  });

const describeFailure = (path: string, args: string[], stderr: string, stdout: string): string => {
  const label = `${path.split("/").pop()} ${args.slice(0, 3).join(" ")}`.trim();
  const detail = (stderr || stdout).trim().split("\n").slice(0, 6).join(" ").slice(0, 400);
  return detail ? `\`${label}\` failed: ${detail}` : `\`${label}\` failed with no output.`;
};

/**
 * devicectl reports the interesting failures in prose, and each has a different
 * fix. Saying which one it is here is the difference between one retry and five.
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

/**
 * Refuse a value that looks like it was meant to be interpreted by a shell.
 * Crude on purpose: nothing here ever reaches a shell, so a false positive costs
 * one renamed file and a false negative would be the bug this server must never
 * have. It runs on paths, which are the one argument class that also flows into
 * `sips` output filenames.
 */
export const assertNoShellMetachars = (label: string, value: string): void => {
  if (/[;&|`$<>\n\r]/.test(value)) {
    throw new CommandError(`Refusing to use ${label} containing shell metacharacters: ${value}`, {
      command: label,
      exitCode: null,
      remedy: "Pass a plain path or identifier with no `;` `&` `|` `` ` `` `$` `<` `>` in it.",
    });
  }
};

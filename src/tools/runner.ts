import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { IosDeviceError, UI_AUTOMATION_REMEDY } from "#/client/errors";
import { isNotAuthorized } from "#/client/wda";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

/**
 * Starting the runner detached, as a seam.
 *
 * Separate from `ExecImpl` because nothing else here spawns a process meant to
 * outlive the call: `execFile` waits for exit, and this one must not be waited
 * for at all. Tests substitute it so the polling, the classification and the
 * argv construction still run for real.
 */
export type SpawnRunner = (
  command: string,
  args: string[],
  opts: { logPath: string; env: Record<string, string> },
) => Promise<number>;

/**
 * The runner belongs to whoever started it, and after this it belongs to us.
 *
 * `detached` plus `unref` is what lets it outlive this server — which is the
 * point, since Bastion restarts a child server freely and the XCTest session
 * must not die with it. The cost is real and worth stating: nothing supervises
 * the result, so a runner left by a previous call is found by inspecting the
 * process table rather than by remembering a pid.
 */
const defaultSpawn: SpawnRunner = async (command, args, { logPath, env }) => {
  const log = await open(logPath, "a");
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env,
    });
    child.unref();
    if (child.pid === undefined) {
      throw new IosDeviceError(`Could not start ${command} — the process had no pid.`);
    }
    return child.pid;
  } finally {
    await log.close();
  }
};

/**
 * Where `scripts/wda.sh` sits relative to this module, which differs between the
 * built package and a source checkout. Probed rather than assumed: getting it
 * wrong fails at spawn time with ENOENT, long after the useful context is gone.
 */
const runnerScript = async (): Promise<string> => {
  const candidates = ["../scripts/wda.sh", "../../scripts/wda.sh", "../../../scripts/wda.sh"];
  for (const relative of candidates) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    try {
      const handle = await open(path, "r");
      await handle.close();
      return path;
    } catch {
      continue;
    }
  }
  throw new IosDeviceError("Could not find `scripts/wda.sh` beside this module.", {
    remedy:
      "Run the runner by hand with `npx -p @mgcrea/mcp-ios-device ios-device-wda run`, or from a " +
      "checkout with `scripts/wda.sh run`.",
  });
};

/** Runner processes currently driving this device, newest last. */
const runningFor = async (client: DeviceClient, udid: string): Promise<number[]> => {
  const { stdout } = await client.exec("/bin/ps", ["-axo", "pid=,command="], client.execTimeoutMs);
  return stdout
    .split("\n")
    .filter((line) => line.includes("test-without-building") && line.includes(udid))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Restarting WebDriverAgent, which is the only way to change whether it is
 * authorized.
 *
 * The XCTest daemon hands a test session its automation grant when the session
 * starts, and never revisits it. Measured on iOS 26.6.1: with the device's
 * Enable UI Automation toggle off, `POST /session` still succeeds and
 * `/wda/activeAppInfo` on that brand-new session still answers `pid: 0` — so no
 * amount of reconnecting, re-sessioning or retrying reaches it. Turning the
 * toggle on does not reach back into a session that already started either.
 * A new process is the whole remedy, which is why it is worth a tool.
 */
export const registerRunnerTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
  spawnRunner: SpawnRunner | undefined = defaultSpawn,
): void => {
  server.registerTool(
    "ios_device_restart_wda",
    {
      title: "iOS Device: Restart WebDriverAgent",
      description:
        "Stop any WebDriverAgent runner driving this device and start a fresh one. This is the " +
        "only way to change whether the runner is authorized to drive the UI: the automation " +
        "grant is given to an XCTest session when it starts and never revisited, so turning on " +
        "Settings > Developer > Enable UI Automation does nothing for a session already running. " +
        "Reach for it when ios_device_diagnostics reports `wda.authorized: false`. The runner is " +
        "started detached and outlives this server, so its output goes to a log file rather than " +
        "to a terminal.",
      inputSchema: z.object({
        device: deviceArg,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(75)
          .describe(
            "How long to wait for the runner to answer before returning. 0 returns as soon as it " +
              "is spawned. Returning early is not a failure — poll ios_device_diagnostics.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ device, wait_seconds }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        if (target.udid === undefined) {
          throw new IosDeviceError(`${target.name ?? target.id} reports no hardware UDID.`, {
            remedy: "Reconnect the device and run ios_device_list_devices to confirm it is seen.",
          });
        }

        // Stopped before starting, not because the port would clash — it would —
        // but because two runners on one device is a state where every tool
        // works intermittently depending on which one answers.
        const stopped = await runningFor(client, target.udid);
        for (const pid of stopped) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already gone, or not ours to kill. Either way the goal is met.
          }
        }
        if (stopped.length > 0) await sleep(2000);

        const script = await runnerScript();
        await mkdir(ctx.config.outputDir, { recursive: true });
        const logPath = join(ctx.config.outputDir, "wda-runner.log");
        const pid = await (spawnRunner ?? defaultSpawn)(script, ["run"], {
          logPath,
          // The full environment, unlike every other child here: `wda.sh` needs
          // `node`, `git` and `xcrun` off a real PATH, and `HOME` to find the
          // checkout it built into. IOS_DEVICE_ID pins the device so the script
          // cannot resolve a different one than the tool just did.
          env: { ...process.env, IOS_DEVICE_ID: target.udid } as Record<string, string>,
        });

        const wda = client.wda(target);
        const deadline = Date.now() + wait_seconds * 1000;
        let reachable = false;
        while (Date.now() < deadline) {
          try {
            await wda.status();
            reachable = true;
            break;
          } catch {
            await sleep(2000);
          }
        }

        if (!reachable) {
          return {
            restarted: true,
            stopped,
            pid,
            log: logPath,
            reachable: false,
            note:
              wait_seconds === 0
                ? "Started. Poll ios_device_diagnostics for `wda.authorized`."
                : `Started, but it was not answering within ${wait_seconds}s. A first run after a ` +
                  "rebuild is slow; read the log, or poll ios_device_diagnostics.",
          };
        }

        // Reachable is not the same as usable, and reporting the first as the
        // second is the exact failure this server was fixed for.
        let authorized = false;
        let authorizationError: string | undefined;
        try {
          await wda.screenshot();
          authorized = true;
        } catch (err) {
          authorizationError = err instanceof Error ? err.message : String(err);
        }

        return {
          restarted: true,
          stopped,
          pid,
          log: logPath,
          reachable: true,
          authorized,
          ...(authorized
            ? {}
            : {
                error: authorizationError,
                remedy: isNotAuthorized(authorizationError)
                  ? `The fresh runner is still refused. ${UI_AUTOMATION_REMEDY} It is read when ` +
                    "the session starts, so turn it on and call this tool again."
                  : "The runner answered but could not capture a screen. Read the log for what " +
                    "xcodebuild reported.",
              }),
        };
      }),
  );
};

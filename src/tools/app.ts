import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { IosDeviceError } from "#/client/errors";
import type { ToolContext } from "#/tools/index";
import { bundleIdArg, confirmArg, deviceArg, ok, wrap, wrapResult } from "#/tools/util";

const requireAbsolute = (label: string, path: string): string => {
  if (!isAbsolute(path)) {
    throw new IosDeviceError(`${label} must be an absolute path, got "${path}".`, {
      remedy:
        "Pass a full path starting with `/`; this server has no working directory to resolve against.",
    });
  }
  return path;
};

/**
 * App lifecycle, through `devicectl`. Write-gated as a family: installing
 * replaces a build, launching or opening a URL starts something on a phone in
 * someone's hand, terminating kills it, uninstalling deletes its data, and
 * pulling a container copies that data onto this machine.
 */
export const registerAppTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "ios_device_install",
    {
      title: "iOS Device: Install",
      description:
        "Install or replace an app on the device from a built `.app` bundle or `.ipa`. Replaces " +
        "an existing installation of the same bundle id in place, keeping its data — a fresh " +
        "install of a debug build is the normal way to get a fix onto the phone. The app must be " +
        "signed with a profile that includes this device's UDID or it will be rejected.",
      inputSchema: z.object({
        device: deviceArg,
        app_path: z
          .string()
          .describe(
            'Absolute path to the built bundle, e.g. "/Users/me/Library/Developer/Xcode/DerivedData/…/Debug-iphoneos/Canopy.app". ' +
              "A Simulator build will not install — it must come from a `Debug-iphoneos` (device) build.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device, app_path }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const result = await client.devicectl.install(
          target.id,
          requireAbsolute("app_path", app_path),
        );
        return { installed: true, device: target.name ?? target.id, result };
      }),
  );

  server.registerTool(
    "ios_device_launch",
    {
      title: "iOS Device: Launch",
      description:
        "Launch an app on the device, optionally with launch arguments, and bring it to the " +
        "foreground. Terminates a running instance first by default, so this is also how you " +
        "restart into a known state. Read the `arguments` note before launching anything that " +
        "talks to a real account. Pass `capture_logs: true` to record the app's console for " +
        "ios_device_read_logs — that is the only way to see its logs.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        arguments: z
          .array(z.string())
          .optional()
          .describe(
            'Launch arguments passed as argv, e.g. ["-DemoMode"]. Omitting this uses ' +
              "IOS_DEVICE_LAUNCH_ARGS, which exists so that an app whose plain launch opens the " +
              "owner's real account can be configured to open fixtures by default instead. " +
              "Passing an explicit empty array [] deliberately overrides that and launches with " +
              "no flags at all.",
          ),
        environment: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Environment variables for the launched process, e.g. {"OS_ACTIVITY_MODE": "info"}.',
          ),
        terminate_existing: z
          .boolean()
          .default(true)
          .describe(
            "Kill a running instance first. On by default, because relaunching without it " +
              "foregrounds the old process and silently ignores the arguments you just passed.",
          ),
        capture_logs: z
          .boolean()
          .default(false)
          .describe(
            "Record the app's stdout, stderr and Logger/os_log output until it exits, for " +
              "ios_device_read_logs. Sets OS_ACTIVITY_DT_MODE in the app's environment, which " +
              "is what makes unified logging reach the console, as it does under Xcode. Replaces " +
              "any earlier capture of the same app.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, bundle_id, arguments: args, environment, terminate_existing, capture_logs }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const launchArgs = args ?? ctx.config.launchArgs;
        if (capture_logs) {
          const capture = await client.consoles.launch({
            device: target.id,
            deviceName: target.name,
            bundleId: bundle_id,
            args: launchArgs,
            env: environment ?? {},
            terminateExisting: terminate_existing,
            outputDir: ctx.config.outputDir,
            // Well under a transport's 60s, whatever IOS_DEVICE_TIMEOUT_MS says:
            // that budget is sized for installs, and this call returns as soon as
            // the app is up rather than when it exits.
            startTimeoutMs: Math.min(ctx.config.execTimeoutMs, 20_000),
          });
          return {
            launched: bundle_id,
            device: target.name ?? target.id,
            arguments: launchArgs,
            argumentsFrom: args ? "call" : "IOS_DEVICE_LAUNCH_ARGS",
            // `--console` blocks until exit, so the pid is not in its answer.
            pid: await client.pidFor(target, bundle_id),
            capturingLogs: client.consoles.running(capture),
            log: capture.path,
          };
        }
        const process = await client.devicectl.launch(target.id, bundle_id, {
          args: launchArgs,
          ...(environment ? { env: environment } : {}),
          terminateExisting: terminate_existing,
        });
        return {
          launched: bundle_id,
          device: target.name ?? target.id,
          arguments: launchArgs,
          // Said back explicitly: a launch that quietly used the configured
          // default when the caller believed it passed nothing is precisely the
          // mistake this field exists to make visible.
          argumentsFrom: args ? "call" : "IOS_DEVICE_LAUNCH_ARGS",
          pid: process?.processIdentifier,
        };
      }),
  );

  server.registerTool(
    "ios_device_open_url",
    {
      title: "iOS Device: Open URL",
      description:
        "Open a URL on the device with whatever handles it: an app's custom scheme " +
        '("canopy://plant/42"), a universal link, or Safari for anything else. This is how to ' +
        "test a deep link end to end, and how to land on a screen deep inside an app without " +
        "tapping your way there. The result names the app that took it, so a link that fell " +
        "through to Safari instead of opening your app is visible at once.",
      inputSchema: z.object({
        device: deviceArg,
        url: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, "A URL needs a scheme, e.g. https: or canopy:")
          .describe(
            'The URL, scheme included, e.g. "canopy://garden/today" or ' +
              '"https://example.com/plant/42". A universal link opens the app only if its ' +
              "associated domains are set up; otherwise it opens in Safari.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, url }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const process = await client.devicectl.openUrl(target.id, url);
        // `file:///…/MobileSafari.app/MobileSafari` → `MobileSafari`.
        const handledBy = process?.executable?.split("/").pop();
        return {
          opened: url,
          device: target.name ?? target.id,
          ...(handledBy ? { handledBy } : {}),
        };
      }),
  );

  server.registerTool(
    "ios_device_uninstall",
    {
      title: "iOS Device: Uninstall",
      description:
        "Remove an app from the device, and with it everything it stored: its container, its " +
        "keychain items' access, its granted permissions. Irreversible. The point is a true " +
        "first launch — onboarding, a migration from nothing, permission prompts — which a " +
        "reinstall over the top never gives you, since ios_device_install keeps the data.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ device, bundle_id }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        await client.devicectl.uninstall(target.id, bundle_id);
        return { uninstalled: bundle_id, device: target.name ?? target.id };
      }),
  );

  server.registerTool(
    "ios_device_terminate",
    {
      title: "iOS Device: Terminate",
      description:
        "Kill a running app by bundle id. Sends SIGTERM so the app can save; `force` sends " +
        "SIGKILL, which is how you reproduce a crash-on-relaunch but loses unsaved state.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        force: z
          .boolean()
          .default(false)
          .describe("Use SIGKILL instead of SIGTERM, so the app cannot save or clean up first."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ device, bundle_id, force }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        const pid = await client.pidFor(target, bundle_id);
        if (pid === undefined) {
          // Not an error: "it is not running" is the state the caller wanted.
          return ok({ terminated: false, reason: `${bundle_id} is not running.` });
        }
        await client.devicectl.terminate(target.id, pid, { kill: force });
        return ok({
          terminated: true,
          bundleId: bundle_id,
          pid,
          signal: force ? "SIGKILL" : "SIGTERM",
        });
      }),
  );

  server.registerTool(
    "ios_device_pull_container",
    {
      title: "iOS Device: Pull Container",
      description:
        "Copy a file or directory out of an app's data container onto this machine — the " +
        "SwiftData or Core Data store, a log file, a cache — so it can be inspected off-device. " +
        "Only works for apps signed for development. This copies real user data belonging to " +
        "whoever holds the phone, which is why it sits behind the write gate despite reading " +
        "rather than writing on the device.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        source: z
          .string()
          .default("/")
          .describe(
            'Path inside the container, e.g. "/Library/Application Support/default.store" or "/" ' +
              "for the whole thing. Relative to the container root, not the filesystem root.",
          ),
        destination: z
          .string()
          .optional()
          .describe(
            "Absolute path on this machine to copy into. Defaults to a directory under " +
              "IOS_DEVICE_OUTPUT_DIR named after the bundle id.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device, bundle_id, source, destination }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const out = destination
          ? requireAbsolute("destination", destination)
          : join(ctx.config.outputDir, bundle_id);
        await mkdir(out, { recursive: true });
        await client.devicectl.copyFrom(target.id, {
          bundleId: bundle_id,
          source,
          destination: out,
        });
        return { pulled: { bundleId: bundle_id, source }, destination: out };
      }),
  );
};

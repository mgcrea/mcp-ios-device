import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { START_RUNNER_REMEDY, UI_AUTOMATION_REMEDY } from "#/client/errors";
import type { DeviceSummary } from "#/client/shape";
import { isNotAuthorized } from "#/client/wda";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

export type Diagnosis = {
  ok: boolean;
  writes: "enabled" | "disabled";
  devices: DeviceSummary[];
  target?: { id: string; name: string | undefined; os: string | undefined };
  /** Undefined when it could not be read at all, which is itself worth seeing. */
  locked?: boolean;
  /**
   * Set when the tunnel looked down and was poked before being judged. Reported
   * so a tunnel that came back is not silently indistinguishable from one that
   * was never broken.
   */
  tunnelPoked?: boolean;
  /**
   * `reachable` is the HTTP server; `authorized` is the XCTest lane behind it.
   * They are genuinely independent, and only the second one decides whether a
   * screenshot or a tap can work.
   */
  wda: {
    url?: string;
    reachable: boolean;
    authorized?: boolean;
    state?: unknown;
    error?: string;
  };
  problems: string[];
  nextSteps: string[];
};

/**
 * The whole point of this tool is that **it never throws**. Every other tool
 * here fails when the device is asleep, the tunnel is down or the runner is not
 * installed, and each of those failures looks much like the others from the
 * outside. This one collects all of it as data and names which half is missing,
 * so "why did my tap not work" is one call rather than four.
 */
export const diagnose = async (
  client: DeviceClient,
  ctx: ToolContext,
  deviceHint?: string,
): Promise<Diagnosis> => {
  const problems: string[] = [];
  const nextSteps: string[] = [];

  let devices: DeviceSummary[] = [];
  try {
    devices = await client.listDevices({ fresh: true });
  } catch (err) {
    problems.push(`Could not list devices: ${err instanceof Error ? err.message : String(err)}`);
    nextSteps.push(
      "Install Xcode and its command line tools, then run `xcrun devicectl list devices`.",
    );
    return {
      ok: false,
      writes: ctx.allowWrites ? "enabled" : "disabled",
      devices,
      wda: { reachable: false },
      problems,
      nextSteps,
    };
  }

  if (devices.length === 0) {
    problems.push("CoreDevice knows about no devices at all.");
    nextSteps.push("Connect the device by USB, unlock it, and tap Trust when prompted.");
  }

  // `resolveDevice` wakes a dormant device itself now — the tunnel-poking used
  // to happen here, as a bolt-on retry after resolution had already failed, but
  // every other tool calls `resolveDevice` too and none of them got the benefit
  // of that retry: `ios_device_screenshot` on a phone with an idle tunnel threw
  // "no CoreDevice tunnel address" while this tool alone reported the same
  // phone as recoverable.
  //
  // Whether a poke happened is derived rather than tracked through a second
  // one: this mirrors `resolveDevice`'s own branching over the same passive
  // read, not the poke itself, so it stays accurate whether resolution
  // succeeded or — a dormant device that failed to wake — still threw.
  const before = devices;
  const attemptedPoke = deviceHint
    ? before.find((d) => d.id === deviceHint || d.udid === deviceHint || d.name === deviceHint)
        ?.state !== "connected"
    : before.every((d) => d.state !== "connected") && before.some((d) => d.state === "paired");

  let target: DeviceSummary | undefined;
  try {
    target = await client.resolveDevice(deviceHint);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    const remedy = (err as { remedy?: string }).remedy;
    if (remedy) nextSteps.push(remedy);
  }

  // Refreshed whenever a poke was attempted, whether or not it worked: a device
  // that failed to wake still deserves this report to reflect its real state
  // rather than the passive read from before the attempt, and Developer Mode
  // and the DDI come off the same cached record and go stale the same way.
  if (attemptedPoke) {
    devices = await client.listDevices({ fresh: true });
    const resolved = target;
    if (resolved) target = devices.find((d) => d.id === resolved.id) ?? resolved;
  }
  const tunnelPoked = attemptedPoke;

  if (target) {
    if (target.developerMode !== "enabled") {
      problems.push(
        `Developer Mode is "${target.developerMode ?? "unknown"}" on ${target.name ?? target.id}.`,
      );
      nextSteps.push(
        "Enable Settings > Privacy & Security > Developer Mode on the device, then reboot it.",
      );
    }
    if (target.ddiUsable === false) {
      problems.push(
        "The developer disk image is not mounted, so developer services are unavailable.",
      );
      nextSteps.push(
        "Open Xcode with the device connected and wait for it to finish preparing the device.",
      );
    }
    if (target.tunnel.state !== "connected") {
      problems.push(
        `The CoreDevice tunnel is "${target.tunnel.state ?? "absent"}", so the screen lane has no route to the device.`,
      );
      nextSteps.push(
        "A usage assertion was already acquired against the device and did not bring the tunnel " +
          "up, so this is not a CoreDevice that merely needed waking. Reconnect the device, or " +
          "run `xcrun xcdevice list --timeout 5` to drive the same discovery Xcode's Devices " +
          "window does. Opening Xcode once is the last resort. Alternatively forward port 8100 " +
          "yourself and set IOS_DEVICE_WDA_URL.",
      );
    }
  }

  let locked: boolean | undefined;
  if (target) {
    try {
      locked = (await client.devicectl.lockState(target.id)).passcodeRequired === true;
    } catch {
      // Not fatal, and not worth a problem line: everything else below still
      // reports, and a device that cannot answer this has louder problems.
    }
    if (locked) {
      problems.push("The device is locked.");
      nextSteps.push(
        "Unlock the phone. A locked device refuses every install and launch, and captures a black screenshot.",
      );
    }
  }

  const wda: Diagnosis["wda"] = { reachable: false };
  if (target) {
    try {
      wda.url = client.wdaUrlFor(target);
      wda.state = await client.wda(target).status();
      wda.reachable = true;
    } catch (err) {
      wda.error = err instanceof Error ? err.message : String(err);
      problems.push(
        "WebDriverAgent is not answering, so screenshots, the UI tree and taps are unavailable.",
      );
      nextSteps.push(
        "Build the runner once with `scripts/wda.sh setup`, then start it. " +
          START_RUNNER_REMEDY +
          " Everything that does not touch the screen — list_devices, list_apps, install, " +
          "launch — works without it.",
      );
      // Only a person standing next to the phone can fix this one, so it has to
      // be named rather than left as "the runner did not start".
      nextSteps.push(
        'If the runner starts and then fails with "Timed out while enabling automation mode", the ' +
          `device is refusing the automation grant. ${UI_AUTOMATION_REMEDY}`,
      );
    }

    // `/status` is served by the HTTP server inside the runner and never crosses
    // into XCTest, so it answers `ready: true` on a runner that cannot perform a
    // single UI action. Everything this tool exists to catch lives on the other
    // side of that line, so it has to be probed rather than inferred: without
    // this, an unauthorized runner reports a clean bill of health while every
    // screenshot, tap and ui_tree fails.
    //
    // `/screenshot` is the probe because it is session-less and is exactly the
    // call that fails first. The image is discarded.
    if (wda.reachable) {
      try {
        await client.wda(target).screenshot();
        wda.authorized = true;
      } catch (err) {
        wda.authorized = false;
        const message = err instanceof Error ? err.message : String(err);
        if (isNotAuthorized(message)) {
          problems.push(
            "WebDriverAgent is answering but is not authorized to perform UI testing actions, so " +
              "screenshots, the UI tree and taps will all fail while everything else works.",
          );
          nextSteps.push(UI_AUTOMATION_REMEDY);
          nextSteps.push(START_RUNNER_REMEDY);
        } else {
          problems.push(
            `WebDriverAgent answered /status but could not capture a screen: ${message}`,
          );
          nextSteps.push(START_RUNNER_REMEDY);
        }
      }
    }
  }

  if (!ctx.allowWrites) {
    nextSteps.push(
      "Writes are off, so the tools that drive the device (tap, swipe, type, launch, install) are not " +
        "registered at all. Set IOS_DEVICE_ALLOW_WRITES=1 and restart the server to get them.",
    );
  }

  return {
    ok: problems.length === 0,
    writes: ctx.allowWrites ? "enabled" : "disabled",
    devices,
    ...(target ? { target: { id: target.id, name: target.name, os: target.os } } : {}),
    ...(locked === undefined ? {} : { locked }),
    ...(tunnelPoked ? { tunnelPoked } : {}),
    wda,
    problems,
    nextSteps,
  };
};

/**
 * Registered first and unconditionally, so a server with no device, no Xcode and
 * no runner is still a useful one rather than a connection that closes.
 */
export const registerDiagnosticsTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "ios_device_diagnostics",
    {
      title: "iOS Device: Diagnostics",
      description:
        "Report everything that decides whether this server can work: which devices CoreDevice " +
        "sees, whether Developer Mode and the developer disk image are ready, whether the tunnel " +
        "that carries the screen lane is up, whether WebDriverAgent is answering, and whether " +
        "writes are enabled. Call this first when a tool is missing or a tap did nothing — it is " +
        "the only tool here that reports failures as data instead of throwing, so it always " +
        "answers.",
      inputSchema: z.object({ device: deviceArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ device }) => wrap(async () => diagnose(client, ctx, device)),
  );

  // The same payload as a resource, so a client can attach the device's standing
  // state once instead of spending a tool call on it before every question.
  server.registerResource(
    "diagnostics",
    "ios-device://diagnostics",
    {
      title: "iOS Device: Diagnostics",
      description:
        "Connected devices, developer-mode state, tunnel state and WebDriverAgent reachability.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await diagnose(client, ctx)),
        },
      ],
    }),
  );

  // Deliberately outside the write gate and outside every other guard: knowing
  // what is plugged in is how you find out why the rest is missing.
  server.registerTool(
    "ios_device_list_devices",
    {
      title: "iOS Device: List Devices",
      description:
        "List the iPhones and iPads CoreDevice knows about, with the identifier the other tools " +
        "take. `state` is the field that matters: a `paired` device gets one wake-up attempt when " +
        "it is the one resolved, so it usually does not need attention, but only a `connected` " +
        "device has a `tunnel.address` right now — that is how the screen lane reaches " +
        "WebDriverAgent.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ({ devices: await client.listDevices({ fresh: true }) })),
  );
};

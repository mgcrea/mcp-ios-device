import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import type { DeviceSummary } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

export type Diagnosis = {
  ok: boolean;
  writes: "enabled" | "disabled";
  devices: DeviceSummary[];
  target?: { id: string; name: string | undefined; os: string | undefined };
  /** Undefined when it could not be read at all, which is itself worth seeing. */
  locked?: boolean;
  wda: { url?: string; reachable: boolean; state?: unknown; error?: string };
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

  let target: DeviceSummary | undefined;
  try {
    target = await client.resolveDevice(deviceHint);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    const remedy = (err as { remedy?: string }).remedy;
    if (remedy) nextSteps.push(remedy);
  }

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
        "Reconnect the device, or open Xcode once to bring the tunnel up. Alternatively forward port 8100 " +
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
        "Build and start the runner: `scripts/wda.sh setup` once, then `scripts/wda.sh run` left " +
          "open. Everything that does not touch the screen — list_devices, list_apps, install, " +
          "launch — works without it.",
      );
      // Only a person standing next to the phone can fix this one, so it has to
      // be named rather than left as "the runner did not start".
      nextSteps.push(
        'If the runner starts and then fails with "Timed out while enabling automation mode", turn ' +
          "on Settings > Developer > Enable UI Automation on the device. It is a separate toggle " +
          "from Developer Mode, cannot be set from this Mac, and is the usual cause.",
      );
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
        "take. `state` is the field that matters: only `connected` devices can be driven, and the " +
        "`tunnel.address` on those is how the screen lane reaches WebDriverAgent.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ({ devices: await client.listDevices({ fresh: true }) })),
  );
};

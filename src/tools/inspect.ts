import { registerScreenTools } from "@mgcrea/mcp-ios-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { EMPTY_SCREENSHOT_REMEDY } from "#/client/screenshot";
import { summarizeApps } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { deviceArg, DEVICE_NAMING, wrap } from "#/tools/util";

/**
 * The observe half: what is installed, how big the screen is, what it looks like
 * and what is on it. None of these change anything, so all four are registered
 * whether or not writes are enabled — an agent that can look but not touch is
 * still useful, and is the safe default this server ships with.
 *
 * Three of the four are shared with the simulator server and live in
 * `#/core/tools/screen`. `list_apps` is the one that cannot be: it is shaped
 * from `devicectl`'s own app record, which has no simulator equivalent.
 */
export const registerInspectTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "ios_device_list_apps",
    {
      title: "iOS Device: List Apps",
      description:
        "List the apps installed on the device, with the bundle id every other tool takes. " +
        "Defaults to developer-installed apps only, which is nearly always what you want — the " +
        "full list including Apple's own is several hundred entries.",
      inputSchema: z.object({
        device: deviceArg,
        include_all: z
          .boolean()
          .default(false)
          .describe(
            "Include Apple's built-in apps and app clips as well. Defaults to false because the " +
              "full list is long enough to be hard to read.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, include_all }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        return { apps: summarizeApps(await client.apps(target, { includeAll: include_all })) };
      }),
  );

  registerScreenTools(server, {
    host: client,
    naming: DEVICE_NAMING,
    maxTreeBytes: ctx.config.maxTreeBytes,
    capHint: "raise IOS_DEVICE_MAX_TREE_BYTES",
    buttons: ["home", "volumeUp", "volumeDown"],
    emptyScreenshotRemedy: EMPTY_SCREENSHOT_REMEDY,
  });
};

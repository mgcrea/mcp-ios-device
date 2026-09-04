import { registerInputTools as registerShared } from "@mgcrea/mcp-ios-core";
import type { McpServer } from "@modelcontextprotocol/server";

import type { DeviceClient } from "#/client/device";
import type { ToolContext } from "#/tools/index";
import { DEVICE_NAMING } from "#/tools/util";

export { EMPTY_SCREENSHOT_REMEDY } from "#/client/screenshot";

/**
 * The drive half. None of these is registered unless IOS_DEVICE_ALLOW_WRITES is
 * set — not refused, absent — because a refusal still lets a model try, retry
 * and reason about a way around it, while a tool that does not exist ends the
 * conversation. Everything here acts on a real phone belonging to a real person.
 *
 * The tools themselves live in `#/core/tools/input`, because a tap is the same
 * W3C pointer sequence over WebDriverAgent on a simulator. What is device-
 * specific is entirely below: which buttons the hardware has, and what to say
 * when a capture comes back blank.
 */
export const registerInputTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
): void => {
  registerShared(server, {
    host: client,
    naming: DEVICE_NAMING,
    maxTreeBytes: ctx.config.maxTreeBytes,
    capHint: "raise IOS_DEVICE_MAX_TREE_BYTES",
    // A simulator has no volume rocker worth pressing; a phone does.
    buttons: ["home", "volumeUp", "volumeDown"],
    emptyScreenshotRemedy:
      "Wake and unlock the device — a locked screen captures nothing — then retry.",
  });
};

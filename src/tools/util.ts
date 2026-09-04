import { createArgs } from "@mgcrea/mcp-ios-core";
import type { ScreenNaming } from "@mgcrea/mcp-ios-core";

export {
  compact,
  fail,
  ok,
  okImage,
  okText,
  toFailure,
  wrap,
  wrapResult,
} from "@mgcrea/mcp-ios-core";
export type { ImageContent, TextContent, ToolResult } from "@mgcrea/mcp-ios-core";

/**
 * How the shared tools name themselves and each other in this server.
 *
 * `copy.target` is written out rather than derived: "CoreDevice identifier" and
 * "hardware UDID" are the two spellings `devicectl` actually accepts, and
 * "connected" is the state that matters here. None of the three means anything
 * to a simulator, which is why the field exists.
 */
export const DEVICE_NAMING: ScreenNaming = {
  prefix: "ios_device",
  title: "iOS Device",
  noun: "device",
  envPrefix: "IOS_DEVICE",
  copy: {
    target:
      "Which device: its CoreDevice identifier, hardware UDID, or name as shown by " +
      "ios_device_list_devices. Omit it when only one device is connected — that is the normal " +
      "case, and IOS_DEVICE_ID pins it when it is not.",
  },
};

const args = createArgs(DEVICE_NAMING);

export const { bundleIdArg, confirmArg, detailArg, screenshotArg, settleArg, xArg, yArg } = args;

/** The device server has always called this `deviceArg`. */
export const deviceArg = args.targetArg;

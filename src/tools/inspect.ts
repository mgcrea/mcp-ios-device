import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { renderScreenshot } from "#/client/screenshot";
import { flattenTree, summarizeApps } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { deviceArg, detailArg, okImage, wrap, wrapResult } from "#/tools/util";

/**
 * The observe half: what is installed, how big the screen is, what it looks like
 * and what is on it. None of these change anything, so all four are registered
 * whether or not writes are enabled — an agent that can look but not touch is
 * still useful, and is the safe default this server ships with.
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

  server.registerTool(
    "ios_device_get_display_info",
    {
      title: "iOS Device: Get Display Info",
      description:
        "Report the screen's geometry and orientation. Worth reading once per session: " +
        "`pointWidth`/`pointHeight` bound every coordinate the tap and swipe tools accept, and " +
        "`orientation` tells you whether the screen you are about to read is rotated.",
      inputSchema: z.object({ device: deviceArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ device }) => wrap(async () => client.display(await client.resolveDevice(device))),
  );

  server.registerTool(
    "ios_device_screenshot",
    {
      title: "iOS Device: Screenshot",
      description:
        "Capture the screen and return it as an image. By default it is scaled to exactly the " +
        "device's point size, which means a position read off this image can be passed straight " +
        "to ios_device_tap with no conversion — the returned metadata says `coordinateSpace: " +
        '"points"` when that holds. Pair it with ios_device_ui_tree rather than choosing between ' +
        "them: the image shows you what the screen looks like, the tree gives you exact labels " +
        "and identifiers. Re-screenshot after every action rather than chaining blind taps.",
      inputSchema: z.object({
        device: deviceArg,
        max_dimension: z
          .number()
          .int()
          .min(120)
          .max(4000)
          .optional()
          .describe(
            "Longest side of the returned image, in pixels. Leave it unset unless you have a " +
              "reason: the default matches the device's point size, and any other value makes " +
              "image positions stop being tap coordinates (the result then reports " +
              '`coordinateSpace: "image_pixels"` and the `pointsPerPixel` factor to multiply by).',
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(70)
          .describe("JPEG quality 1-100. Flat interface screenshots stay perfectly legible at 70."),
        save_path: z
          .string()
          .optional()
          .describe(
            "Also write the full-resolution PNG to this absolute path, for attaching to a bug " +
              "report. The returned image is still the downscaled one.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, max_dimension, quality, save_path }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        const display = await client.display(target);
        const png = await client.wda(target).screenshot();
        const rendered = await renderScreenshot({
          pngBase64: png,
          display,
          sipsPath: client.sipsPath,
          exec: client.exec,
          timeoutMs: client.execTimeoutMs,
          maxDimension: max_dimension,
          quality,
          savePath: save_path,
        });
        return okImage(
          { type: "image", data: rendered.data, mimeType: rendered.mimeType },
          {
            device: target.name ?? target.id,
            width: rendered.width,
            height: rendered.height,
            coordinateSpace: rendered.coordinateSpace,
            pointsPerPixel: rendered.pointsPerPixel,
            orientation: display.orientation,
            bytes: rendered.bytes,
            ...(rendered.savedTo ? { savedTo: rendered.savedTo } : {}),
            ...(rendered.coordinateSpace === "points"
              ? {}
              : {
                  warning:
                    "This image is not in point space. Multiply positions read off it by " +
                    "`pointsPerPixel` before passing them to ios_device_tap.",
                }),
          },
        );
      }),
  );

  server.registerTool(
    "ios_device_ui_tree",
    {
      title: "iOS Device: UI Tree",
      description:
        "List the addressable elements on screen — type, label, accessibility identifier, and the " +
        "exact point to tap — flattened rather than nested. Prefer this over reading coordinates " +
        "off a screenshot whenever you can: a label or identifier survives the screen moving, and " +
        "a pixel position does not. The raw hierarchy is tens of KB, so this returns controls " +
        "only by default; use `contains` or `types` to narrow further and `detail` to widen. " +
        "Coordinates are in points, the same space ios_device_tap takes.",
      inputSchema: z.object({
        device: deviceArg,
        detail: detailArg,
        contains: z
          .string()
          .optional()
          .describe(
            'Keep only elements whose label, identifier or value contains this, case-insensitively — e.g. "Today".',
          ),
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Keep only these element types, without the `XCUIElementType` prefix, e.g. ["Button", "Cell"].',
          ),
        include_invisible: z
          .boolean()
          .default(false)
          .describe(
            "Include elements XCUITest marks as not visible. Off by default: they cannot be " +
              "tapped, and on a scrolling list they outnumber the visible ones many times over.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, detail, contains, types, include_invisible }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const source = await client.wda(target).source();
        return flattenTree(source, {
          detail,
          ...(contains ? { contains } : {}),
          ...(types ? { types } : {}),
          includeInvisible: include_invisible,
          maxBytes: ctx.config.maxTreeBytes,
        });
      }),
  );
};

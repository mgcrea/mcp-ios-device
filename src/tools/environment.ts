import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { IosDeviceError } from "#/client/errors";
import { deviceArg, wrap } from "#/tools/util";

/**
 * Staging the device: appearance, Dynamic Type, accessibility and location.
 *
 * Named and shaped after `ios_simulator_set_environment` on purpose, so the two
 * servers stage the same way. What differs is whose settings these are. On a
 * simulator they belong to a throwaway device; here they are the owner's own
 * phone, and they persist after this server is gone. Measured on iOS 27.0:
 * dark mode and a simulated location both take effect at once and stay until
 * changed back. That is why this is write-gated and destructive, and why the
 * description tells the caller to put things back.
 *
 * What is deliberately not here, because the phone refuses it: a status bar
 * override and simulated biometrics are not in its CoreDevice capability list
 * (they are simulator features), and `orientation set` reports success while
 * the device stays in portrait.
 */
export const registerEnvironmentTools = (server: McpServer, client: DeviceClient): void => {
  server.registerTool(
    "ios_device_set_environment",
    {
      title: "iOS Device: Set Environment",
      description:
        "Stage the device for a test or a screenshot: dark mode, Dynamic Type size, Increase " +
        "Contrast, Reduce Motion, and a simulated GPS location. Every field is optional and " +
        "only those given change. These are the owner's real settings and they persist after " +
        "you are done, so put each one back afterwards (appearance and text size included) and " +
        "pass `clear_location: true` to stop the simulated location. A status bar override and " +
        "simulated Face ID are simulator-only and not available here.",
      inputSchema: z.object({
        device: deviceArg,
        appearance: z.enum(["light", "dark"]).optional().describe("Interface style."),
        content_size: z
          .enum([
            "extra-small",
            "small",
            "medium",
            "large",
            "extra-large",
            "extra-extra-large",
            "extra-extra-extra-large",
            "accessibility-medium",
            "accessibility-large",
            "accessibility-extra-large",
            "accessibility-extra-extra-large",
            "accessibility-extra-extra-extra-large",
          ])
          .optional()
          .describe(
            'Dynamic Type size; "large" is the iOS default. The accessibility- sizes are where ' +
              "layouts break, and turn on Larger Accessibility Sizes as they are set.",
          ),
        increase_contrast: z.boolean().optional().describe("Increase Contrast accessibility mode."),
        reduce_motion: z.boolean().optional().describe("Reduce Motion accessibility mode."),
        location: z
          .object({
            latitude: z.number().min(-90).max(90).describe("Decimal degrees, e.g. 48.8584."),
            longitude: z.number().min(-180).max(180).describe("Decimal degrees, e.g. 2.2945."),
          })
          .optional()
          .describe(
            "Simulate the device's GPS position for every app until cleared with " +
              "`clear_location`.",
          ),
        clear_location: z
          .boolean()
          .optional()
          .describe("Stop simulating a location and return to the real one."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({
      device,
      appearance,
      content_size,
      increase_contrast,
      reduce_motion,
      location,
      clear_location,
    }) =>
      wrap(async () => {
        if (location && clear_location) {
          throw new IosDeviceError("`location` and `clear_location` contradict each other.", {
            remedy: "Pass one of them.",
          });
        }
        const target = await client.resolveDevice(device);
        const applied: Record<string, unknown> = {};

        const settings = {
          ...(appearance ? { mode: appearance } : {}),
          ...(content_size ? { textSize: content_size } : {}),
          ...(increase_contrast !== undefined ? { increaseContrast: increase_contrast } : {}),
          ...(reduce_motion !== undefined ? { reduceMotion: reduce_motion } : {}),
        };
        if (Object.keys(settings).length > 0) {
          // One devicectl call for all of them: each one is a round trip to the
          // phone, and one switch back to light mode was measured at ~14s.
          await client.devicectl.setAppearance(target.id, settings);
          Object.assign(
            applied,
            appearance ? { appearance } : {},
            content_size ? { content_size } : {},
            increase_contrast !== undefined ? { increase_contrast } : {},
            reduce_motion !== undefined ? { reduce_motion } : {},
          );
        }
        if (location) {
          await client.devicectl.simulateLocation(target.id, location.latitude, location.longitude);
          applied["location"] = location;
        }
        if (clear_location) {
          await client.devicectl.clearLocation(target.id);
          applied["location"] = "cleared";
        }

        if (Object.keys(applied).length === 0) {
          throw new IosDeviceError("Nothing to change: every field was omitted.", {
            remedy:
              "Pass at least one of appearance, content_size, increase_contrast, reduce_motion, location, clear_location.",
          });
        }
        return { device: target.name ?? target.id, applied };
      }),
  );
};

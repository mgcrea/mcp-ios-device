import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeviceClient } from "#/client/device";
import { IosDeviceError } from "#/client/errors";
import { renderScreenshot } from "#/client/screenshot";
import type { DeviceSummary } from "#/client/shape";
import type { PointerAction } from "#/client/wda";
import type { ToolContext } from "#/tools/index";
import { deviceArg, ok, okImage, wrapResult, xArg, yArg, type ToolResult } from "#/tools/util";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every action tool ends here, and by default it ends with a fresh screenshot.
 *
 * That default is a correctness decision rather than a convenience. A tap is
 * aimed at a position that was true when the last screenshot was taken; if the
 * screen moved in between — a sheet appeared, a list settled, an alert opened —
 * the tap landed somewhere else and nothing about the result would say so.
 * Returning the resulting screen makes the mistake visible on the same call that
 * made it, which is the difference between noticing immediately and building
 * three more actions on top of a wrong one.
 */
const actionResult = async (
  client: DeviceClient,
  target: DeviceSummary,
  summary: Record<string, unknown>,
  opts: { screenshot: boolean; settleMs: number },
): Promise<ToolResult> => {
  if (!opts.screenshot) return ok({ ...summary, ok: true });
  // Let the animation finish. Screenshotting mid-transition returns a frame
  // that is neither the old screen nor the new one, which reads as a failure.
  await sleep(opts.settleMs);
  const display = await client.display(target);
  const wda = client.wda(target);
  const rendered = await renderScreenshot({
    pngBase64: await wda.screenshot(),
    display,
    sipsPath: client.sipsPath,
    exec: client.exec,
    timeoutMs: client.execTimeoutMs,
    quality: 70,
  });
  const alert = await wda.alertText();
  return okImage(
    { type: "image", data: rendered.data, mimeType: rendered.mimeType },
    {
      ...summary,
      ok: true,
      width: rendered.width,
      height: rendered.height,
      coordinateSpace: rendered.coordinateSpace,
      // An alert swallows every subsequent tap while telling you nothing, so it
      // is worth one field on every action rather than a puzzle later.
      ...(alert ? { alert } : {}),
    },
  );
};

const tapActions = (x: number, y: number, holdMs: number): PointerAction[] => [
  { type: "pointerMove", duration: 0, x, y },
  { type: "pointerDown", button: 0 },
  { type: "pause", duration: holdMs },
  { type: "pointerUp", button: 0 },
];

/** NSPredicate strings are double-quoted; a label containing one would end it early. */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The drive half. None of these is registered unless IOS_DEVICE_ALLOW_WRITES is
 * set — not refused, absent — because a refusal still lets a model try, retry
 * and reason about a way around it, while a tool that does not exist ends the
 * conversation. Everything here acts on a real phone belonging to a real person.
 */
export const registerInputTools = (
  server: McpServer,
  client: DeviceClient,
  _ctx: ToolContext,
): void => {
  const screenshotArg = z
    .boolean()
    .default(true)
    .describe(
      "Return a screenshot of the resulting screen. On by default, and worth leaving on: it is " +
        "how you find out that the action landed where you meant it to. Turn it off only for a " +
        "sequence whose intermediate states you do not need to see.",
    );

  const settleArg = z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(600)
    .describe(
      "Milliseconds to wait before the follow-up screenshot, so an animation finishes first. " +
        "Raise it for a screen that loads data; a capture taken mid-transition shows neither state.",
    );

  server.registerTool(
    "ios_device_tap",
    {
      title: "iOS Device: Tap",
      description:
        "Tap a position on screen, in points. Prefer ios_device_tap_element when the target has a " +
        "label or an accessibility identifier — a position stops being right the moment the " +
        "layout shifts, and nothing about a wrong tap looks wrong. Coordinates come from a " +
        "default ios_device_screenshot image or from a `tap` field in ios_device_ui_tree, which " +
        "are the same space.",
      inputSchema: z.object({
        device: deviceArg,
        x: xArg,
        y: yArg,
        hold_ms: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .default(50)
          .describe(
            "How long to hold the touch, in milliseconds. Around 700 makes it a long press, which " +
              "is what opens context menus and edit affordances.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      // Not destructiveHint: a tap does not itself destroy anything, but it can
      // land on a control that does — which is exactly why the whole family sits
      // behind the write gate rather than relying on this annotation.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, x, y, hold_ms, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        await client.wda(target).pointer(tapActions(x, y, hold_ms));
        return actionResult(
          client,
          target,
          { tapped: [x, y] },
          { screenshot, settleMs: settle_ms },
        );
      }),
  );

  server.registerTool(
    "ios_device_tap_element",
    {
      title: "iOS Device: Tap Element",
      description:
        "Tap the element with this accessibility identifier or label, letting the device resolve " +
        "its position. This is the tool to reach for: it survives the screen scrolling, the " +
        "layout changing and the copy being reworded, none of which a coordinate does. Give " +
        "exactly one of `id`, `label` or `predicate`; identifiers from ios_device_ui_tree.",
      inputSchema: z.object({
        device: deviceArg,
        id: z
          .string()
          .optional()
          .describe(
            'Accessibility identifier — the `id` field from ios_device_ui_tree, e.g. "garden.tab". ' +
              "The most durable way to address an element, because it is set in code and does not " +
              "change when the visible text does.",
          ),
        label: z
          .string()
          .optional()
          .describe(
            'Exact accessibility label, i.e. the visible text — e.g. "Today". Matched exactly, ' +
              "and it changes with the app's language, so prefer `id` where one exists.",
          ),
        predicate: z
          .string()
          .optional()
          .describe(
            'Escape hatch: a raw NSPredicate over element attributes, e.g. `type == "XCUIElementTypeButton" AND label BEGINSWITH "Add"`.',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Which match to tap when several match, zero-based. The call reports how many matched, " +
              "so a surprising count is worth checking before assuming the first one is right.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, id, label, predicate, index, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const given = [id, label, predicate].filter((v) => v !== undefined);
        if (given.length !== 1) {
          throw new IosDeviceError("Give exactly one of `id`, `label` or `predicate`.", {
            remedy:
              "Call ios_device_ui_tree to see which identifiers and labels the screen actually has.",
          });
        }
        const target = await client.resolveDevice(device);
        const wda = client.wda(target);
        const [using, value] =
          id !== undefined
            ? (["accessibility id", id] as const)
            : label !== undefined
              ? ([
                  "predicate string",
                  `label == ${quote(label)} OR name == ${quote(label)}`,
                ] as const)
              : (["predicate string", predicate as string] as const);

        const uuids = await wda.findElements(using, value);
        const chosen = uuids[index];
        if (!chosen) {
          throw new IosDeviceError(
            `No element matched ${using} ${value}${uuids.length > 0 ? ` at index ${index} (${uuids.length} matched)` : ""}.`,
            {
              remedy:
                "Call ios_device_ui_tree to see what is on screen — the element may not have " +
                "appeared yet, or may be scrolled out of view.",
            },
          );
        }
        const rect = await wda.elementRect(chosen);
        await wda.click(chosen);
        return actionResult(
          client,
          target,
          { tapped: { using, value, index, matched: uuids.length, rect } },
          { screenshot, settleMs: settle_ms },
        );
      }),
  );

  server.registerTool(
    "ios_device_swipe",
    {
      title: "iOS Device: Swipe",
      description:
        "Drag from one point to another, in points — how you scroll a list, pull to refresh, or " +
        "swipe a row open. To scroll down a page, swipe from low on the screen to high on it. " +
        "`duration_ms` is what separates a scroll from a fling: a short one throws the list past " +
        "where you aimed.",
      inputSchema: z.object({
        device: deviceArg,
        from_x: xArg,
        from_y: yArg,
        to_x: xArg,
        to_y: yArg,
        duration_ms: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .default(400)
          .describe(
            "How long the drag takes. 400 is a controlled scroll; under 150 becomes a fling with " +
              "momentum, which lands somewhere you did not choose.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, from_x, from_y, to_x, to_y, duration_ms, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        await client.wda(target).pointer([
          { type: "pointerMove", duration: 0, x: from_x, y: from_y },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: duration_ms, x: to_x, y: to_y },
          { type: "pointerUp", button: 0 },
        ]);
        return actionResult(
          client,
          target,
          { swiped: { from: [from_x, from_y], to: [to_x, to_y], durationMs: duration_ms } },
          { screenshot, settleMs: settle_ms },
        );
      }),
  );

  server.registerTool(
    "ios_device_type",
    {
      title: "iOS Device: Type",
      description:
        "Type text into whatever currently has keyboard focus, or into a named field. Focus is " +
        "the trap: with nothing focused the keystrokes go nowhere and the call still succeeds, so " +
        "pass `id` or `label` to have the field tapped first unless you know a field is already " +
        "active.",
      inputSchema: z.object({
        device: deviceArg,
        text: z
          .string()
          .min(1)
          .describe("The text to type. Sent character by character, as a real keyboard would."),
        id: z
          .string()
          .optional()
          .describe(
            "Accessibility identifier of the field to focus first — from ios_device_ui_tree.",
          ),
        label: z
          .string()
          .optional()
          .describe("Exact label of the field to focus first, if it has no identifier."),
        clear_first: z
          .boolean()
          .default(false)
          .describe(
            "Replace the field's contents instead of appending. Only possible when `id` or " +
              "`label` names the field — there is no way to clear a field addressed only by focus.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, text, id, label, clear_first, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        const wda = client.wda(target);

        if (id !== undefined || label !== undefined) {
          const [using, value] =
            id !== undefined
              ? (["accessibility id", id] as const)
              : ([
                  "predicate string",
                  `label == ${quote(label as string)} OR name == ${quote(label as string)}`,
                ] as const);
          const uuid = (await wda.findElements(using, value))[0];
          if (!uuid) {
            throw new IosDeviceError(`No field matched ${using} ${value}.`, {
              remedy: 'Call ios_device_ui_tree with detail "all" to see the fields on screen.',
            });
          }
          if (clear_first) {
            await wda.setValue(uuid, text);
          } else {
            await wda.click(uuid);
            await wda.keys(text);
          }
        } else {
          if (clear_first) {
            throw new IosDeviceError("`clear_first` needs `id` or `label` to name the field.", {
              remedy:
                "Pass the field's accessibility identifier, or drop clear_first and type into the focused field.",
            });
          }
          await wda.keys(text);
        }

        return actionResult(
          client,
          target,
          { typed: text.length },
          { screenshot, settleMs: settle_ms },
        );
      }),
  );

  server.registerTool(
    "ios_device_press_button",
    {
      title: "iOS Device: Press Button",
      description:
        "Press a hardware button. `home` is the way back to the home screen and the reliable way " +
        "to background the app under test without terminating it.",
      inputSchema: z.object({
        device: deviceArg,
        name: z
          .enum(["home", "volumeUp", "volumeDown"])
          .describe(
            "Which button. `home` works on Face ID devices too — it is the gesture, not the " +
              "physical button.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, name, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await client.resolveDevice(device);
        await client.wda(target).pressButton(name);
        return actionResult(client, target, { pressed: name }, { screenshot, settleMs: settle_ms });
      }),
  );
};

import { z } from "zod";

import { IosDeviceError } from "#/client/errors";

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds a fifth to a third to every
 * response, worst on wide lists of short-keyed objects — which is exactly the
 * shape `ios_device_ui_tree` returns.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/** Return text as-is, for anything a model should read rather than parse. */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/**
 * An image plus its metadata, in that order. The metadata line is not optional
 * decoration: it carries the coordinate space, and a caller that reads pixel
 * positions off the image without knowing what space it is in will tap the
 * wrong place with nothing looking wrong.
 */
export const okImage = (image: ImageContent, meta: unknown): ToolResult => ({
  content: [image, { type: "text", text: JSON.stringify(meta) }],
});

/**
 * `extra` is spread at the top level, not nested under `details`, so a `remedy`
 * lands beside the error rather than three levels inside an envelope. The remedy
 * is the half a model should act on, and a nested one gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving the remedy and any detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof IosDeviceError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning throws into tool errors. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (an image, raw text). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

// ----------------------------------------------------------------- arg atoms --

export const deviceArg = z
  .string()
  .optional()
  .describe(
    "Which device: its CoreDevice identifier, hardware UDID, or name as shown by " +
      "ios_device_list_devices. Omit it when only one device is connected — that is the normal " +
      "case, and IOS_DEVICE_ID pins it when it is not.",
  );

export const bundleIdArg = z
  .string()
  .regex(
    /^[A-Za-z0-9.-]+$/,
    "A bundle id is dot-separated alphanumerics, e.g. `io.mgcrea.Canopy` — not an app name or a path.",
  )
  .describe(
    'The app\'s bundle identifier, e.g. "io.mgcrea.Canopy". List them with ios_device_list_apps.',
  );

/**
 * Every coordinate this server accepts or returns is in points. That is not an
 * arbitrary choice: it is the space `ios_device_ui_tree` rects are in, and the
 * space a default `ios_device_screenshot` image is scaled to, so a position read
 * from either can be passed here unchanged.
 */
export const xArg = z
  .number()
  .describe(
    "Horizontal position in points, from the left edge. This is the same space as the `tap` " +
      "field from ios_device_ui_tree and as a default ios_device_screenshot image — no conversion.",
  );

export const yArg = z
  .number()
  .describe(
    "Vertical position in points, from the top edge. Same space as ios_device_ui_tree `tap` and a " +
      "default ios_device_screenshot image.",
  );

/** Destructive tools require this, so an agent can never trigger one in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes state on a real device.");

export const detailArg = z
  .enum(["interactive", "labelled", "all"])
  .default("interactive")
  .describe(
    "How much of the hierarchy to return. `interactive` (default) is controls only — buttons, " +
      "cells, fields, switches — and is what you want to decide where to tap. `labelled` adds " +
      "text and images that carry a label, for reading the screen's content. `all` is every " +
      "visible node and is usually far too large to be useful.",
  );

/** Drop undefined values so an optional argument is omitted rather than sent empty. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

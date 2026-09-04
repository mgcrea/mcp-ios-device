import { renderScreenshot as render, type RenderOptions } from "@mgcrea/mcp-ios-core";

export type { RenderedScreenshot, RenderOptions } from "@mgcrea/mcp-ios-core";

/** A locked phone captures nothing, and that is by far the usual cause here. */
export const EMPTY_SCREENSHOT_REMEDY =
  "Wake and unlock the device — a locked screen captures nothing — then retry.";

/** `renderScreenshot`, pre-loaded with the wording a physical device needs. */
export const renderScreenshot = (opts: RenderOptions): ReturnType<typeof render> =>
  render({ emptyRemedy: EMPTY_SCREENSHOT_REMEDY, ...opts });

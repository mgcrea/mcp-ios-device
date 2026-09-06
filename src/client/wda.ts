import type { WdaRemedies } from "@mgcrea/mcp-ios-core";

import { startRunnerRemedy, UI_AUTOMATION_REMEDY, wdaUnavailableRemedy } from "#/client/errors";

export { isNotAuthorized, WdaClient } from "@mgcrea/mcp-ios-core";
export type {
  Locator,
  PointerAction,
  WdaNode,
  WdaOptions,
  WdaRect,
  WdaRemedies,
} from "@mgcrea/mcp-ios-core";

/**
 * What to say when WebDriverAgent fails, on a physical device.
 *
 * The protocol is the same one a simulator speaks; the fixes are not. Every
 * string here ends in something only a phone has — a runner signed for your
 * team, a Settings toggle that cannot be flipped from this Mac, a forwarded
 * port. `WdaClient` carries no copy of its own, so this is the only place these
 * are written.
 */
export const deviceWdaRemedies = (allowWrites: boolean): WdaRemedies => ({
  unavailable: wdaUnavailableRemedy(allowWrites),
  notAuthorized:
    "WebDriverAgent is running but is not authorized to drive the UI, so screenshots, the UI " +
    `tree and taps will all fail while everything else keeps working. ${UI_AUTOMATION_REMEDY} ` +
    // Order matters here and nowhere else: flipping the toggle does nothing to
    // the session already running, so the restart is the second half of one fix
    // rather than an alternative to the first.
    `Then: ${startRunnerRemedy(allowWrites)}`,
  noForegroundApp:
    "WebDriverAgent reporting no foreground app on a session it has just created is " +
    "usually an unauthorized runner rather than a missing app — check " +
    `ios_device_diagnostics for \`wda.authorized\`. ${UI_AUTOMATION_REMEDY} ` +
    `Then: ${startRunnerRemedy(allowWrites)}`,
  noSuchElement:
    "Call ios_device_ui_tree to see what is actually on screen — the element may not have appeared yet.",
});

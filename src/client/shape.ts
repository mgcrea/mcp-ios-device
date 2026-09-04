// The context-window layer.
//
// Both upstream sources here are enormous relative to what they are worth.
// `devicectl list devices` spends ~10 KB on four devices, nearly all of it a
// `capabilities` array of forty feature identifiers that no caller acts on. A
// WebDriverAgent `/source` for one real screen is tens of KB of nested JSON, and
// passing it through would not merely cost tokens — it would make the model
// walk a tree to find a tappable rect, which is a join it can silently get wrong.
//
// So: lists return the few fields the other tools consume, and the UI tree is
// flattened to addressable elements with the tap point already computed.

import type { RawApp, RawDevice } from "#/client/devicectl";

export type DeviceSummary = {
  id: string;
  name: string | undefined;
  model: string | undefined;
  os: string | undefined;
  udid: string | undefined;
  state: "connected" | "paired" | "unavailable";
  /** Everything the screen lane needs, and the usual reason it does not work. */
  tunnel: { state: string | undefined; address: string | undefined };
  developerMode: string | undefined;
  ddiUsable: boolean | undefined;
  /**
   * When CoreDevice last had a live tunnel to this device, ISO 8601. Undefined
   * for one it has never reached. This is what orders which paired-but-dormant
   * device gets woken first when more than one qualifies — the one seen most
   * recently is the one most likely to still be around.
   */
  lastConnectionDate: string | undefined;
};

/**
 * A device is only *usable* when the tunnel is up: that address is how the
 * WebDriverAgent lane reaches port 8100, so a `paired` device with no tunnel
 * can install an app and cannot see the screen. Reporting both separately is
 * what lets `ios_device_diagnostics` name which half is missing.
 */
export const summarizeDevice = (device: RawDevice): DeviceSummary => {
  const connection = device.connectionProperties ?? {};
  const properties = device.deviceProperties ?? {};
  const hardware = device.hardwareProperties ?? {};
  return {
    id: device.identifier,
    name: properties.name,
    model: hardware.marketingName ?? hardware.productType,
    os: properties.osVersionNumber,
    udid: hardware.udid,
    state:
      connection.tunnelState === "connected"
        ? "connected"
        : connection.pairingState === "paired"
          ? "paired"
          : "unavailable",
    tunnel: { state: connection.tunnelState, address: connection.tunnelIPAddress },
    developerMode: properties.developerModeStatus,
    ddiUsable: properties.ddiServicesAvailable,
    lastConnectionDate: connection.lastConnectionDate,
  };
};

export type AppSummary = {
  bundleId: string;
  name: string | undefined;
  version: string | undefined;
  build: string | undefined;
  /** True for anything installed from Xcode, which is what a debug session cares about. */
  developer: boolean | undefined;
};

export const summarizeApps = (apps: RawApp[]): AppSummary[] =>
  apps
    .filter((app) => typeof app.bundleIdentifier === "string")
    .map((app) => ({
      bundleId: app.bundleIdentifier as string,
      name: app.name,
      version: app.version,
      build: app.bundleVersion,
      developer: app.builtByDeveloper,
    }));

// ------------------------------------------------------------------ UI tree --

export { flattenTree, INTERACTIVE_TYPES, isTrue, shortType } from "@mgcrea/mcp-ios-core";
export type { FlattenOptions, UiDetail, UiElement, UiTreeResult } from "@mgcrea/mcp-ios-core";

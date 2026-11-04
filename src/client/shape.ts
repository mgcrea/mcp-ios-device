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
  const facts = deviceFacts(device);
  return {
    id: device.identifier,
    name: facts.name,
    model: facts.marketingName ?? facts.productType,
    os: facts.osVersion,
    udid: facts.udid,
    state:
      facts.tunnelState === "connected"
        ? "connected"
        : facts.pairingState === "paired"
          ? "paired"
          : "unavailable",
    tunnel: { state: facts.tunnelState, address: facts.tunnelAddress },
    developerMode: facts.developerMode,
    ddiUsable: facts.ddiServicesAvailable,
    lastConnectionDate: facts.lastConnectionDate,
  };
};

/** Seconds between the Unix epoch and 2001-01-01 UTC, Foundation's reference date. */
const REFERENCE_DATE_OFFSET_S = 978_307_200;

/**
 * The facts this server reads off a `list devices` entry, from devicectl's
 * `properties` dictionary first and the deprecated `*Properties` blocks second.
 *
 * Field by field rather than block by block: Xcode 27 sends both, and the day
 * the old blocks are removed is not a day to discover that one field had only
 * ever been read from them. `ddiServicesAvailable` is the one fact with no
 * counterpart in `properties`, so it ends up undefined then — which diagnostics
 * already treats as "not known to be broken" rather than a failure.
 */
export const deviceFacts = (device: RawDevice) => {
  const modern = device.properties ?? {};
  const connection = device.connectionProperties ?? {};
  const legacy = device.deviceProperties ?? {};
  const hardware = { ...device.hardwareProperties, ...modern.hardware };
  const since2001 = modern.connection?.lastConnectionDate;
  const developerMode = modern.state?.developerModeStatus;
  return {
    platform: hardware.platform,
    reality: hardware.reality,
    udid: hardware.udid,
    marketingName: hardware.marketingName,
    productType: hardware.productType,
    name: modern.state?.name ?? legacy.name,
    osVersion: modern.software?.osVersionNumber?.stringValue ?? legacy.osVersionNumber,
    developerMode: developerMode ? Object.keys(developerMode)[0] : legacy.developerModeStatus,
    ddiServicesAvailable: legacy.ddiServicesAvailable,
    pairingState: modern.connection?.pairingState ?? connection.pairingState,
    tunnelState: modern.connection?.state ?? connection.tunnelState,
    tunnelAddress: modern.connection?.tunnelIPAddressString ?? connection.tunnelIPAddress,
    // ISO 8601 either way: `device.ts` orders wake-up candidates by comparing
    // these as strings.
    lastConnectionDate:
      since2001 !== undefined
        ? new Date((since2001 + REFERENCE_DATE_OFFSET_S) * 1000).toISOString()
        : connection.lastConnectionDate,
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

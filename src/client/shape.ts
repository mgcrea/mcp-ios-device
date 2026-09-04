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
import type { WdaNode, WdaRect } from "#/client/wda";

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

export type UiElement = {
  type: string;
  label?: string;
  id?: string;
  value?: string;
  /** `[x, y, width, height]`, in points. Array rather than an object: four keys per element adds up. */
  rect: [number, number, number, number];
  /**
   * The point to tap, precomputed. Without it every caller re-derives
   * `x + width / 2` from the rect, and the one that gets it wrong taps a
   * neighbour with nothing looking wrong.
   */
  tap: [number, number];
  disabled?: true;
};

export type UiTreeResult = {
  coordinateSpace: "points";
  elements: UiElement[];
  /** How many matched before the byte cap, so a truncated answer is obviously partial. */
  matched: number;
  truncated?: string;
};

export type UiDetail = "interactive" | "labelled" | "all";

/**
 * The controls a tap can meaningfully land on. Deliberately a list rather than
 * "anything with an action": XCUITest reports almost every node as hittable, so
 * an is-it-tappable heuristic returns the whole tree and defeats the point.
 */
const INTERACTIVE_TYPES = new Set([
  "Button",
  "Cell",
  "CheckBox",
  "DatePicker",
  // A home-screen app icon and a keyboard key are both plain taps, and both are
  // reported as their own type rather than as buttons.
  "Icon",
  "Key",
  "Link",
  "MenuItem",
  "PickerWheel",
  "RadioButton",
  "SearchField",
  "SecureTextField",
  "SegmentedControl",
  "Slider",
  "Stepper",
  "Switch",
  "Tab",
  "TextField",
  "TextView",
  "Toggle",
]);

/**
 * `XCUIElementTypeButton` → `Button`. A live WDA already reports the short form
 * in `/source`; the long one is what predicates and older builds use, so both
 * have to land on the same name or a `types` filter matches nothing.
 */
export const shortType = (type: string | undefined): string =>
  (type ?? "Unknown").replace(/^XCUIElementType/, "");

/**
 * WDA's JSON source reports booleans as the strings `"1"` and `"0"` — not
 * `"true"`/`"false"`, and not JSON booleans. Measured against WDA 16.12.3 on
 * iOS 26.6.1; accepting all three costs nothing and the narrow version of this
 * check silently filtered out every element on the screen.
 */
const isTrue = (value: string | boolean | undefined): boolean =>
  value === true || value === "true" || value === "1";

const textOf = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
};

const hasArea = (rect: WdaRect | undefined): rect is WdaRect =>
  rect !== undefined && rect.width > 0 && rect.height > 0;

const keep = (node: WdaNode, detail: UiDetail): boolean => {
  if (detail === "all") return true;
  const type = shortType(node.type);
  if (INTERACTIVE_TYPES.has(type)) return true;
  if (detail === "interactive") return false;
  return (
    (type === "StaticText" || type === "Image" || type === "Other") &&
    (textOf(node.label) !== undefined || textOf(node.name) !== undefined)
  );
};

const toElement = (node: WdaNode, rect: WdaRect): UiElement => {
  const label = textOf(node.label) ?? textOf(node.name);
  const identifier = textOf(node.rawIdentifier);
  const value = textOf(node.value);
  return {
    type: shortType(node.type),
    ...(label ? { label } : {}),
    // Only when it adds something: SwiftUI mirrors the label into the
    // identifier unless one was set deliberately, and repeating it doubles the
    // cost of the single field that makes addressing survive a copy change.
    ...(identifier && identifier !== label ? { id: identifier } : {}),
    ...(value && value !== label ? { value } : {}),
    rect: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)],
    tap: [round(rect.x + rect.width / 2), round(rect.y + rect.height / 2)],
    ...(isTrue(node.isEnabled) ? {} : { disabled: true as const }),
  };
};

const round = (n: number): number => Math.round(n);

export type FlattenOptions = {
  detail?: UiDetail;
  /** Case-insensitive substring match against label, id and value. */
  contains?: string;
  /** Keep only these short type names, e.g. `["Button", "Cell"]`. */
  types?: string[];
  maxBytes: number;
  /** Include elements XCUITest marks invisible. Off by default — they cannot be tapped. */
  includeInvisible?: boolean;
};

/**
 * Depth-first flatten. Flat rather than nested is the decision that makes this
 * affordable: nesting spends a `children` array and an indentation level on
 * every container, and a caller looking for something to tap reads the leaves.
 */
export const flattenTree = (root: WdaNode, opts: FlattenOptions): UiTreeResult => {
  const detail = opts.detail ?? "interactive";
  const needle = opts.contains?.toLowerCase();
  const wantedTypes = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;

  const matches: UiElement[] = [];
  const visit = (node: WdaNode): void => {
    const rect = node.rect;
    const visible = opts.includeInvisible === true || isTrue(node.isVisible);
    if (visible && hasArea(rect) && keep(node, detail)) {
      const element = toElement(node, rect);
      const typeOk = !wantedTypes || wantedTypes.has(element.type);
      const textOk =
        needle === undefined ||
        [element.label, element.id, element.value].some((v) => v?.toLowerCase().includes(needle));
      if (typeOk && textOk) matches.push(element);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  // Trim to the byte budget by dropping from the end, so what survives is the
  // top of the screen — which is where a caller reading a fresh screen looks
  // first, and keeps the answer stable rather than reshuffled.
  const elements: UiElement[] = [];
  let bytes = 0;
  for (const element of matches) {
    const size = JSON.stringify(element).length + 1;
    if (bytes + size > opts.maxBytes) break;
    elements.push(element);
    bytes += size;
  }

  return {
    coordinateSpace: "points",
    elements,
    matched: matches.length,
    ...(elements.length < matches.length
      ? {
          truncated:
            `Showing ${elements.length} of ${matches.length} elements (${opts.maxBytes} byte cap). ` +
            `Narrow it with \`contains\`, \`types\`, or raise IOS_DEVICE_MAX_TREE_BYTES.`,
        }
      : {}),
  };
};

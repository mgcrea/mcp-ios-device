# @mgcrea/mcp-ios-device

Model Context Protocol server for driving a **physical iPhone or iPad** from a model: screenshot
the screen, read its accessibility tree, tap, swipe, type, and manage the app under test. Read-only
by default — the tools that touch the device are not merely refused without `IOS_DEVICE_ALLOW_WRITES`,
they are never registered.

It exists because the Simulator cannot exercise a camera, on-device inference, real sensors or
real push, so the bugs that matter most only reproduce on hardware — and reproducing one there
otherwise means a person holding the phone and narrating.

## Features

- **See the screen.** A screenshot scaled to exactly the device's point size, so positions read
  off the image are tap coordinates with no conversion.
- **Read the screen.** A flattened, pruned accessibility tree — type, label, identifier and the
  precomputed tap point per element — instead of the tens of KB of nested JSON WebDriverAgent
  actually returns.
- **Drive the screen.** Tap by coordinate or by accessibility identifier, swipe, type, hardware
  buttons. Every action returns the resulting screen by default, so a mis-aimed tap is visible
  on the call that made it.
- **Manage the app.** Install a build, launch it with arguments, terminate it, pull its data
  container off the device.
- **TypeScript only.** Three npm dependencies at runtime, one of them our own, and no Python,
  no `iproxy`, no usbmux client, no Appium server. See
  [How it reaches the device](#how-it-reaches-the-device).

## Security

**Blast radius.** With writes enabled, this server can tap anything on an unlocked phone that
belongs to a real person: send a message, make a purchase, delete data. That is not a
hypothetical widening of scope — it is what "drive the UI" means. Read the write-gate section
before turning it on, and prefer `IOS_DEVICE_LAUNCH_ARGS` to pin the app under test into a
fixture mode.

**Your credentials.** There are none. The server holds no tokens and talks to no vendor API. It
reaches the device through `xcrun devicectl` and a locally-reachable HTTP server, both of which
are already authorised by the trust relationship between this Mac and this phone.

**Supply chain.** Three runtime dependencies: `@modelcontextprotocol/server`, `zod`, and
[`@mgcrea/mcp-ios-core`](../mcp-ios-core) — our own, and itself dependent on only the first two.
The core holds the half of this server that a simulator drives identically: the WebDriverAgent
client, the accessibility-tree flattening, the screenshot renderer and the tap/swipe/type tools.
It is a peer package rather than a subpath of this one because
[`mcp-ios-simulator`](../mcp-ios-simulator) needs none of what is left here — `devicectl`, the
tunnel, the signed runner — and shipping it a whole second server to reuse half of it would be the
wrong dependency direction. Scaling
images uses `sips`, which ships with macOS, specifically so an image library does not have to be
installed into a process that holds device access.

**What it can read.** `ios_device_pull_container` copies an app's private data — a SwiftData
store, logs, caches — onto this machine. It is behind the write gate and requires `confirm`
despite being a read on the device, because that data belongs to whoever holds the phone.

## How it reaches the device

Two lanes, and knowing which is which explains every error message this server produces.

| Lane                     | Carries                                                                     | Needs                                   |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------- |
| `xcrun devicectl`        | devices, apps, install, launch, terminate, container copy, display geometry | Xcode. Nothing on the phone.            |
| WebDriverAgent over HTTP | screenshot, UI tree, tap, swipe, type, buttons                              | a runner built and running on the phone |

The interesting part is the second lane's transport. A device CoreDevice has connected to is
already routable from this Mac at an IPv6 address it reports as `tunnelIPAddress` — an `fd…::1`
on a `utun` interface, with a route in the kernel table. So WebDriverAgent's port 8100 is
reachable as `http://[fd1f:…::1]:8100` from plain `fetch`, with no port forwarding of any kind.

That is what removes `pymobiledevice3`, `go-ios`, `iproxy` and the Appium server from the
picture, and it is why the whole server is TypeScript.

`ios_device_diagnostics` reports both lanes separately, so "the device is fine but the runner is
not up" is a distinguishable answer rather than a generic failure.

## Configure

| Variable                    | Default                   | What it does                                                                                          |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `IOS_DEVICE_ID`             | the only connected device | CoreDevice identifier, UDID, or name. Two connected devices and no value is an error that names them. |
| `IOS_DEVICE_ALLOW_WRITES`   | off                       | Registers the nine tools that drive the device.                                                       |
| `IOS_DEVICE_LAUNCH_ARGS`    | none                      | Launch arguments applied when `ios_device_launch` does not pass its own.                              |
| `IOS_DEVICE_WDA_URL`        | derived from the tunnel   | Explicit WebDriverAgent URL, when something else forwards the port.                                   |
| `IOS_DEVICE_WDA_PORT`       | `8100`                    | Port WebDriverAgent listens on.                                                                       |
| `IOS_DEVICE_MAX_TREE_BYTES` | `24000`                   | Byte cap on a `ui_tree` payload.                                                                      |
| `IOS_DEVICE_TIMEOUT_MS`     | `120000`                  | Budget for one `devicectl` call; a large install is slow.                                             |
| `IOS_DEVICE_WDA_TIMEOUT_MS` | `30000`                   | Budget for one WebDriverAgent call.                                                                   |
| `IOS_DEVICE_OUTPUT_DIR`     | `$TMPDIR/mcp-ios-device`  | Where saved screenshots and pulled containers land.                                                   |
| `IOS_DEVICE_DEBUG`          | off                       | Log every `devicectl` and WebDriverAgent call to stderr.                                              |

The same keys in camelCase can go in `~/.config/ios-device-mcp/config.json`
(`IOS_DEVICE_CONFIG` to move it). The environment wins **per field**, so a one-off
`IOS_DEVICE_ALLOW_WRITES=0` beats a file that says `true`. Unknown keys in the file are an
error rather than silently ignored — a typo that looks like "that setting had no effect" is the
worst way to learn where your configuration came from.

See [.env.example](.env.example) for the annotated version.

## Quick start

Requires macOS with Xcode, and a device that is paired, unlocked, has Developer Mode on, and has
**Settings → Developer → Enable UI Automation** on. That last toggle is separate from Developer
Mode and is the one people miss.

### A. Observe only, no setup

```bash
npx -y @mgcrea/mcp-ios-device
```

`list_devices`, `list_apps`, `get_display_info` and `diagnostics` work immediately.

### B. The screen lane

`screenshot`, `ui_tree` and everything that taps need a WebDriverAgent runner on the device.
Build and install it once:

```bash
IOS_DEVICE_TEAM_ID=YOURTEAMID scripts/wda.sh setup   # ~5 minutes, signs with your team
scripts/wda.sh run                                    # leave this running
scripts/wda.sh status                                 # is it answering?
```

Installed from npm rather than a checkout, the same script is the `ios-device-wda` binary:

```bash
IOS_DEVICE_TEAM_ID=YOURTEAMID npx -p @mgcrea/mcp-ios-device ios-device-wda setup
npx -p @mgcrea/mcp-ios-device ios-device-wda run
```

`run` has to stay open: the HTTP server _is_ the XCTest process, so it stops when the test
session does. The first run may put an untrusted-developer prompt on the phone — trust your
team in Settings → General → VPN & Device Management, then run it again.

### C. Wired into a client

```json
{
  "mcpServers": {
    "ios-device": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-ios-device"],
      "env": { "IOS_DEVICE_ALLOW_WRITES": "1", "IOS_DEVICE_LAUNCH_ARGS": "-DemoMode" }
    }
  }
}
```

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | grep -o '"name":"[a-z_]*"' | sort -u
```

## Tools

| Tool                          | What it does                                         | Writes? |
| ----------------------------- | ---------------------------------------------------- | ------- |
| `ios_device_diagnostics`      | Both lanes' state and what to fix. Never throws.     | no      |
| `ios_device_list_devices`     | Devices CoreDevice sees, with tunnel state           | no      |
| `ios_device_list_apps`        | Installed apps and their bundle ids                  | no      |
| `ios_device_get_display_info` | Screen size in pixels and points, orientation        | no      |
| `ios_device_screenshot`       | The screen, scaled into point space                  | no      |
| `ios_device_ui_tree`          | Flattened, pruned accessibility tree with tap points | no      |
| `ios_device_tap`              | Tap a point                                          | **yes** |
| `ios_device_tap_element`      | Tap by accessibility id, label or predicate          | **yes** |
| `ios_device_swipe`            | Drag between two points                              | **yes** |
| `ios_device_type`             | Type into the focused field, or a named one          | **yes** |
| `ios_device_press_button`     | home, volume up, volume down                         | **yes** |
| `ios_device_install`          | Install a `.app` or `.ipa`                           | **yes** |
| `ios_device_launch`           | Launch with arguments and environment                | **yes** |
| `ios_device_terminate`        | Kill a running app by bundle id                      | **yes** |
| `ios_device_pull_container`   | Copy an app's data container to this Mac             | **yes** |
| `ios_device_restart_wda`      | Stop and restart the WebDriverAgent runner           | **yes** |

Plus one resource, `ios-device://diagnostics`, carrying the same payload as the tool so a client
can attach the device's standing state instead of spending a call on it.

## Reproducing a bug on a real device

```
ios_device_diagnostics                                  → device connected, WDA answering
ios_device_launch      { bundle_id: "io.mgcrea.Canopy" } → relaunches in demo mode
ios_device_screenshot                                    → the Garden tab
ios_device_ui_tree     { contains: "Today" }             → { type: "Button", label: "Today", tap: [140, 920] }
ios_device_tap_element { label: "Today" }                → taps it, returns the new screen
ios_device_type        { id: "search.field", text: "monstera" }
ios_device_pull_container { bundle_id: "io.mgcrea.Canopy",
                            source: "/Library/Application Support", confirm: true }
```

Prefer `tap_element` over `tap`: a label or identifier survives the list scrolling and the copy
being reworded, and a coordinate does not.

## What it costs

Measured against an iPhone 17 Pro Max on iOS 26.6.1, WebDriverAgent 16.12.3:

| Call                         | Time    | Payload                                         |
| ---------------------------- | ------- | ----------------------------------------------- |
| `list_devices`               | ~50 ms  | 1.1 KB, from a 10.7 KB `devicectl` envelope     |
| `get_display_info`           | ~165 ms | 200 B                                           |
| `screenshot`                 | ~0.6 s  | 440x956 JPEG, ~90 KB — roughly 540 image tokens |
| `ui_tree` on an app screen   | ~1.3 s  | 4 KB, from a 154 KB `/source`                   |
| `ui_tree` on the home screen | ~5.7 s  | 2.2 KB, 23 elements                             |
| `tap_element`                | ~2 s    | plus a screenshot unless turned off             |

The home screen is the slow case for `/source`; a normal app screen is four times
faster. If `ui_tree` is the bottleneck in a loop, narrow it with `contains` rather than
reaching for coordinates.

## Traps worth knowing

- **Coordinates are points, everywhere.** A default screenshot is scaled to exactly the point
  size so that its pixels _are_ points. Pass `max_dimension` and that stops being true — the
  result then says `coordinateSpace: "image_pixels"` and gives the factor to multiply by.
- **A locked phone captures nothing** and refuses every launch. The failure says so, but it is
  the first thing to check.
- **The runner dies with its terminal.** `scripts/wda.sh run` is not a daemon. When taps stop
  working, that window is usually why. `ios_device_restart_wda` starts one detached instead, which
  survives that but logs to a file rather than to your screen.
- **The automation grant is per XCTest session, not per request.** Enabling
  Settings → Developer → Enable UI Automation does nothing for a runner that is already up: the
  grant is handed out when the session starts and never revisited. Measured on iOS 26.6.1 with the
  toggle off, `POST /session` still succeeds and `/wda/activeAppInfo` on that fresh session still
  answers `pid: 0`, so no amount of re-sessioning reaches it. Toggle, then restart the runner — in
  that order.
- **A relaunch without `terminate_existing` ignores your arguments.** It foregrounds the running
  process instead, so the flags you just passed have no effect and nothing says so. It defaults
  to on for this reason.
- **`IOS_DEVICE_LAUNCH_ARGS` applies silently** when a launch passes no `arguments`. The result
  reports `argumentsFrom` so you can tell which happened; pass `arguments: []` to mean "no flags"
  deliberately.
- **An alert swallows every tap** while reporting nothing useful. Action results include an
  `alert` field when one is on screen.
- **WebDriverAgent reports booleans as `"1"` and `"0"`**, not `true`/`false`. Only relevant
  if you parse `/source` yourself — this server already handles it — but the narrow version
  of that check returns an empty tree that looks exactly like a working answer.
- **The tunnel is not the Wi-Fi address.** `tunnel.address` is an `fd…::1` on a `utun`
  interface, only routable from this Mac, and only while CoreDevice keeps it up.

## Troubleshooting

Start with `ios_device_diagnostics`; it names which half is wrong. Then:

- **"Connection closed" in the client** — run `node dist/cli.js` by hand with the same
  environment; the error the client swallowed is on stderr.
- **Tools missing** — the driving tools only exist with `IOS_DEVICE_ALLOW_WRITES` set. Check the
  startup banner, which prints `writes=ENABLED` or `writes=disabled`.
- **WebDriverAgent not reachable** — `scripts/wda.sh status`. If the tunnel address is missing,
  reconnect the device or open Xcode once to bring the tunnel up.
- **"Not authorized for performing UI testing actions"** — the runner is up and its XCTest lane is
  not. A healthy `/status` does not imply a working screen lane: `/status` is answered by the HTTP
  server inside the runner and never crosses into XCTest, so it reports `ready: true` on a runner
  that cannot take a single screenshot. Turn on **Settings → Developer → Enable UI Automation** on
  the device, then restart `scripts/wda.sh run`. `ios_device_diagnostics` probes this directly and
  reports it as `wda.authorized`.
- **`node: command not found` in the runner log** — `scripts/wda.sh` parses devicectl's JSON with
  node, and a host that embeds its own runtime leaves nothing called `node` on `PATH`.
  `ios_device_restart_wda` passes `NODE` and extends `PATH` for exactly this; running the script by
  hand from such an environment needs `NODE=/path/to/node`.
- **`ui_tree` is empty** — the screen may genuinely have no controls; try `detail: "labelled"`.
  A truncated answer always says so in `truncated`.
- **Provisioning expired** — a development profile lasts a year on a paid team. Re-run
  `scripts/wda.sh setup` to re-sign.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

The suite runs offline with no device: `exec` and `fetch` are both injectable, so `xcrun` and
WebDriverAgent are stubbed while the tools, the SDK's own validation and the shaping layer all
run for real.

Publish:

```bash
pnpm dlx release-it            # bump, commit, tag
git push --follow-tags         # CI publishes to npm from the tag
```

## License

MIT — see [LICENSE](LICENSE).

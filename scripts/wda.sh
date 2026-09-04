#!/usr/bin/env bash
# Build, install and run WebDriverAgent — the half of mcp-ios-device that can see
# and touch the screen.
#
# WDA is an XCTest runner. Apple only lets XCTest drive another app's UI, which
# is why nothing else can do this, and why it has to be signed for your team and
# installed on the device once. Everything after that is plain HTTP on port 8100,
# reached over the tunnel CoreDevice already maintains — no iproxy, no usbmux, no
# Python, no Appium server.
#
#   scripts/wda.sh setup    clone + build + install the runner (once, ~5 minutes)
#   scripts/wda.sh run      start it and keep it running (leave this open)
#   scripts/wda.sh status   is it answering?
#
# Environment:
#   IOS_DEVICE_TEAM_ID   Apple Developer team, e.g. 75QE9PRT3V   (required for setup)
#   IOS_DEVICE_ID        CoreDevice identifier or UDID           (default: the only connected device)
#   WDA_DIR              checkout location                       (default: ~/.cache/mcp-ios-device/WebDriverAgent)
#   WDA_REF              git tag to pin                          (default: v16.12.3)
set -euo pipefail

WDA_DIR="${WDA_DIR:-$HOME/.cache/mcp-ios-device/WebDriverAgent}"
WDA_REF="${WDA_REF:-v16.12.3}"
DERIVED="${WDA_DIR}/.build"
PORT="${IOS_DEVICE_WDA_PORT:-8100}"

die() { echo "error: $*" >&2; exit 1; }

# The device record, straight from devicectl's JSON — the same source the server
# uses, so the script and the server can never disagree about which device or
# which address they mean.
device_json() {
  local out; out="$(mktemp -d)/devices.json"
  xcrun devicectl list devices --quiet --json-output "$out" >/dev/null
  node -e '
    const devices = require(process.argv[1]).result.devices;
    const want = process.env.IOS_DEVICE_ID;
    const connected = devices.filter((d) => d.connectionProperties?.tunnelState === "connected");
    const match = want
      ? devices.find((d) => d.identifier === want || d.hardwareProperties?.udid === want || d.deviceProperties?.name === want)
      : connected.length === 1 ? connected[0] : undefined;
    if (!match) {
      console.error(connected.length > 1
        ? "Several devices are connected. Set IOS_DEVICE_ID to one of: " + connected.map((d) => `${d.deviceProperties?.name} = ${d.identifier}`).join(", ")
        : "No connected device. Plug one in, unlock it, and trust this Mac.");
      process.exit(1);
    }
    console.log(JSON.stringify({
      id: match.identifier,
      udid: match.hardwareProperties?.udid,
      name: match.deviceProperties?.name,
      address: match.connectionProperties?.tunnelIPAddress,
    }));
  ' "$out"
}

field() { node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(String(d[process.argv[2]]??""))' "$1" "$2"; }

cmd_setup() {
  [ -n "${IOS_DEVICE_TEAM_ID:-}" ] || die "set IOS_DEVICE_TEAM_ID to your Apple Developer team id (e.g. 75QE9PRT3V)"
  local dev udid name
  dev="$(device_json)"; udid="$(field "$dev" udid)"; name="$(field "$dev" name)"
  echo "==> device: $name ($udid)"

  if [ ! -d "$WDA_DIR/.git" ]; then
    echo "==> cloning appium/WebDriverAgent $WDA_REF"
    mkdir -p "$(dirname "$WDA_DIR")"
    git clone --depth 1 --branch "$WDA_REF" https://github.com/appium/WebDriverAgent.git "$WDA_DIR"
  else
    echo "==> reusing $WDA_DIR"
    git -C "$WDA_DIR" fetch --depth 1 origin "refs/tags/$WDA_REF:refs/tags/$WDA_REF" 2>/dev/null || true
    git -C "$WDA_DIR" checkout -q "$WDA_REF"
  fi

  # A bundle id derived from the team keeps two developers' runners from
  # colliding on the same App ID, which is the usual cause of a provisioning
  # failure that reads like a signing bug.
  local bundle="com.${IOS_DEVICE_TEAM_ID}.WebDriverAgentRunner"
  echo "==> building and installing the runner (bundle $bundle)"
  xcodebuild build-for-testing \
    -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
    -scheme WebDriverAgentRunner \
    -destination "id=$udid" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$IOS_DEVICE_TEAM_ID" \
    PRODUCT_BUNDLE_IDENTIFIER="$bundle"

  echo
  echo "Built. Now run: scripts/wda.sh run"
  echo "The first run puts an untrusted-developer prompt on the phone —"
  echo "  Settings > General > VPN & Device Management > trust your team, then run it again."
}

cmd_run() {
  local dev udid name xctestrun
  dev="$(device_json)"; udid="$(field "$dev" udid)"; name="$(field "$dev" name)"
  xctestrun="$(ls "$DERIVED"/Build/Products/WebDriverAgentRunner_iphoneos*.xctestrun 2>/dev/null | head -1 || true)"
  [ -n "$xctestrun" ] || die "no build found in $DERIVED — run \`scripts/wda.sh setup\` first"

  echo "==> starting WebDriverAgent on $name"
  echo "    it stays up for as long as this command runs; Ctrl-C stops it"
  # `test-without-building` is what keeps the runner alive: the XCTest session is
  # the process, so the HTTP server dies with it. There is no daemon mode.
  exec xcodebuild test-without-building \
    -xctestrun "$xctestrun" \
    -destination "id=$udid"
}

cmd_status() {
  local dev address name url
  dev="$(device_json)"; address="$(field "$dev" address)"; name="$(field "$dev" name)"
  [ -n "$address" ] || die "$name has no CoreDevice tunnel address — reconnect it, or open Xcode once"
  url="http://[${address}]:${PORT}/status"
  echo "==> $url"
  if curl -fsS --max-time 5 "$url"; then
    echo
  else
    echo "not answering — run \`scripts/wda.sh run\`" >&2
    exit 1
  fi
}

case "${1:-}" in
  setup) cmd_setup ;;
  run) cmd_run ;;
  status) cmd_status ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

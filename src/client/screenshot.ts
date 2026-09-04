import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DisplayInfo } from "#/client/devicectl";
import { IosDeviceError } from "#/client/errors";
import { assertNoShellMetachars, type ExecImpl } from "#/client/exec";

/**
 * Downscaling, and the coordinate space it decides.
 *
 * A raw device screenshot is 1320x2868 pixels on this class of phone — several
 * megabytes, and far past anything worth putting in a context window. It has to
 * be scaled down, and the scale factor chosen is not a cosmetic decision: it
 * defines the space whoever reads the image will name coordinates in.
 *
 * So the default is not "some smaller number". It is **exactly the point size**
 * — native pixels divided by `pointScale`, 440x956 here. That is the logical
 * resolution the interface was laid out at, it is what WebDriverAgent's `/source`
 * rects and `/actions` coordinates are already in, and it makes the whole server
 * speak one coordinate space: a point read off the image is a point that can be
 * tapped, with no arithmetic in between and therefore no arithmetic to get wrong.
 *
 * Scaling is done by `sips`, which ships with macOS. That keeps the promise that
 * this server has no runtime npm dependencies — an image library would be the
 * single largest one, on a process that already holds device access.
 */
export type RenderOptions = {
  pngBase64: string;
  display: DisplayInfo;
  sipsPath: string;
  exec: ExecImpl;
  timeoutMs: number;
  /**
   * Longest side of the output, in pixels. Omitted means the point size, which
   * is the case that keeps image coordinates and tap coordinates identical.
   */
  maxDimension?: number | undefined;
  /** JPEG quality 1-100. Screenshots of flat UI stay legible well below 80. */
  quality: number;
  /** Also keep the full-resolution PNG here. */
  savePath?: string | undefined;
};

export type RenderedScreenshot = {
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /**
   * "points" when image pixels and device points coincide, so coordinates read
   * off the image can be passed straight to ios_device_tap. Anything else and
   * the caller has been handed a conversion to do, which the tool result says
   * out loud rather than leaving to be discovered.
   */
  coordinateSpace: "points" | "image_pixels";
  pointsPerPixel: number;
  bytes: number;
  savedTo?: string;
};

const readDimensions = async (
  path: string,
  opts: { sipsPath: string; exec: ExecImpl; timeoutMs: number },
): Promise<{ width: number; height: number }> => {
  const { stdout } = await opts.exec(
    opts.sipsPath,
    ["-g", "pixelWidth", "-g", "pixelHeight", path],
    opts.timeoutMs,
  );
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new IosDeviceError(
      `Could not read image dimensions from sips output: ${stdout.slice(0, 200)}`,
    );
  }
  return { width, height };
};

export const renderScreenshot = async (opts: RenderOptions): Promise<RenderedScreenshot> => {
  const png = Buffer.from(opts.pngBase64, "base64");
  if (png.byteLength === 0) {
    throw new IosDeviceError("WebDriverAgent returned an empty screenshot.", {
      remedy: "Wake and unlock the device — a locked screen captures nothing — then retry.",
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "ios-shot-"));
  const source = join(dir, "shot.png");
  const output = join(dir, "shot.jpg");
  try {
    await writeFile(source, png);
    const native = await readDimensions(source, opts);

    // Derive the target from the *captured* image rather than from the display
    // record, so a landscape capture scales by its own longest side instead of
    // a portrait assumption that would put every coordinate at 90 degrees.
    const longest = Math.max(native.width, native.height);
    const target = opts.maxDimension ?? Math.round(longest / opts.display.pointScale);

    await opts.exec(
      opts.sipsPath,
      [
        "-Z",
        String(target),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(opts.quality),
        source,
        "--out",
        output,
      ],
      opts.timeoutMs,
    );

    const rendered = await readDimensions(output, opts);
    const jpeg = await readFile(output);

    // How many device points one image pixel covers. 1 on the default path.
    const pointsPerPixel = native.width / opts.display.pointScale / rendered.width;
    const isPointSpace = Math.abs(pointsPerPixel - 1) < 0.01;

    let savedTo: string | undefined;
    if (opts.savePath) {
      assertNoShellMetachars("savePath", opts.savePath);
      await mkdir(dirname(opts.savePath), { recursive: true });
      await writeFile(opts.savePath, png);
      savedTo = opts.savePath;
    }

    return {
      data: jpeg.toString("base64"),
      mimeType: "image/jpeg",
      width: rendered.width,
      height: rendered.height,
      coordinateSpace: isPointSpace ? "points" : "image_pixels",
      pointsPerPixel: Math.round(pointsPerPixel * 1000) / 1000,
      bytes: jpeg.byteLength,
      ...(savedTo ? { savedTo } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

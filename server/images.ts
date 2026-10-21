import heicDecoder from "heic-decode/lib.js";
import libheif from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import { Animation, decode as decodeWithImagescript } from "imagescript";
import UTIF from "utif2";
import { matchesMagic, type MagicSignature } from "../shared/kinds";
import { decodeGif, gifFrameCount, gifSize } from "./gif";
import { decodePngScaled, pngHeader } from "./png";
import { tiffDirectories } from "./tiff";
import {
  MAX_STREAMED_PIXELS,
  assertDecodable,
  decodeJpegBytes,
  decodePngBytes,
  encoded,
  fitRgba,
  orient,
  resize,
  spend,
  targetScale,
  type DecodeBudget,
  type EncodedImage,
  type Fit,
  type Rgba,
} from "./raster";
import { ERROR_MESSAGES, errorCode, errorText } from "../shared/errors";
import { ANIMATION_MAX_BYTES } from "../shared/limits";

interface Size {
  width: number;
  height: number;
}

export type AnimationMimeType = "image/gif" | "image/webp";

interface ImageCodec {
  name: string;
  magic: readonly MagicSignature[];
  passthrough?: EncodedImage["mimeType"];
  animation?: { mimeType: AnimationMimeType; frames(bytes: Buffer): number; gif?(bytes: Buffer): Promise<Buffer> };
  size(bytes: Buffer): Size | Promise<Size>;
  decode?(bytes: Buffer): Rgba | Promise<Rgba>;
  scaled?(bytes: Buffer, width: number, height: number): Promise<Rgba> | null;
  orientation?(bytes: Buffer): number;
}

const ascii = (offset: number, text: string): MagicSignature => ({
  offset,
  bytes: Array.from(text, (char) => char.charCodeAt(0)),
});

function exifOrientation(bytes: Buffer): number {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) break;
    const length = bytes.readUInt16BE(offset + 2);
    const tiff = offset + 10;
    if (marker === 0xe1 && bytes.toString("latin1", offset + 4, offset + 10) === "Exif\0\0" && tiff + 8 <= bytes.length) {
      const little = bytes.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
      const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      const end = Math.min(bytes.length, offset + 2 + length);
      if (ifd + 2 <= end) {
        for (let i = 0, count = u16(ifd); i < count && ifd + 2 + i * 12 + 12 <= end; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      }
    }
    offset += 2 + length;
  }
  return 1;
}

function displayedJpegSize(bytes: Buffer): Size {
  const size = jpegSize(bytes);
  return exifOrientation(bytes) >= 5 ? { width: size.height, height: size.width } : size;
}

function jpegSize(bytes: Buffer): Size {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error(ERROR_MESSAGES.imageDamaged("JPEG", "no frame header"));
}

const TIFF_MAX_RATIO: Record<number, number> = { 1: 1, 32773: 64, 8: 1100, 32946: 1100, 5: 2000 };
const TIFF_DEFAULT_RATIO = 2000;

function tiffNumbers(page: UTIF.IFD, tag: string): number[] {
  const value = (page as Record<string, unknown>)[tag];
  return Array.isArray(value) ? value.map(Number) : [];
}

function assertTiffData(bytes: Buffer, page: UTIF.IFD): void {
  const [width = 0] = tiffNumbers(page, "t256");
  const [height = 0] = tiffNumbers(page, "t257");
  const [bits = 1] = tiffNumbers(page, "t258");
  const [samples = 1] = tiffNumbers(page, "t277");
  const [compression = 1] = tiffNumbers(page, "t259");
  const tiled = tiffNumbers(page, "t324").length > 0;
  const offsets = tiffNumbers(page, tiled ? "t324" : "t273");
  const counts = tiffNumbers(page, tiled ? "t325" : "t279");
  const damaged = (detail: string) => new Error(ERROR_MESSAGES.imageDamaged("TIFF", detail));
  if (offsets.length === 0 || offsets.length !== counts.length) throw damaged("missing strip table");
  let stored = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] + counts[i] > bytes.length) throw damaged("strip outside the file");
    stored += counts[i];
  }
  const expected = Math.ceil((width * bits * samples) / 8) * height;
  if (stored * (TIFF_MAX_RATIO[compression] ?? TIFF_DEFAULT_RATIO) < expected) throw damaged("strips are smaller than its dimensions");
}

function firstTiffPage(bytes: Buffer): UTIF.IFD {
  const page = tiffDirectories(bytes).find((ifd) => ifd.t256 && ifd.t257);
  if (!page) throw new Error(ERROR_MESSAGES.imageDamaged("TIFF", "no image directory"));
  return page;
}

let heic: ReturnType<typeof heicDecoder> | undefined;
const heicCodec = () => (heic ??= heicDecoder(libheif()));

async function heicSize(bytes: Buffer): Promise<Size> {
  const images = await heicCodec().all({ buffer: bytes });
  try {
    return { width: images[0].width, height: images[0].height };
  } finally {
    images.dispose();
  }
}

const ANMF_HEADER_BYTES = 16;

function webpImages(data: Buffer, found: Size[] = []): Size[] {
  for (let at = 0; at + 8 <= data.length; ) {
    const type = data.toString("latin1", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const body = data.subarray(at + 8, Math.min(data.length, at + 8 + size));
    if (type === "VP8X" && body.length >= 10) {
      found.push({ width: body.readUIntLE(4, 3) + 1, height: body.readUIntLE(7, 3) + 1 });
    } else if (type === "VP8L" && body.length >= 5 && body[0] === 0x2f) {
      const bits = body.readUInt32LE(1);
      found.push({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    } else if (type === "VP8 " && body.length >= 10) {
      found.push({ width: body.readUInt16LE(6) & 0x3fff, height: body.readUInt16LE(8) & 0x3fff });
    } else if (type === "ANMF") {
      webpImages(body.subarray(ANMF_HEADER_BYTES), found);
    }
    at += 8 + size + (size & 1);
  }
  return found;
}

function webpSize(bytes: Buffer): Size {
  const [canvas] = webpImages(bytes.subarray(12));
  if (!canvas) throw new Error(ERROR_MESSAGES.imageDamaged("WebP", "no image data"));
  return canvas;
}

function webpFrameCount(bytes: Buffer): number {
  let frames = 0;
  for (let at = 12; at + 8 <= bytes.length && frames < 2; ) {
    const size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end <= bytes.length && bytes.toString("latin1", at, at + 4) === "ANMF") frames++;
    at = end + (size & 1);
  }
  return frames;
}

async function decodeWebp(bytes: Buffer): Promise<Rgba> {
  for (const { width, height } of webpImages(bytes.subarray(12))) assertDecodable(width, height);
  const decoded = await decodeWithImagescript(bytes, true);
  const { width, height, bitmap } = Array.isArray(decoded) ? decoded[0] : decoded;
  return { width, height, data: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength) };
}

const GIF_MAX_FRAMES = 500;
const GIF_MAX_DECODED_PIXELS = 32_000_000;

async function webpToGif(bytes: Buffer): Promise<Buffer> {
  const [canvas, ...frames] = webpImages(bytes.subarray(12));
  if (!canvas) throw new Error(ERROR_MESSAGES.imageDamaged("WebP", "no image data"));
  const pixels = frames.reduce((total, frame) => total + canvas.width * canvas.height + frame.width * frame.height, 0);
  if (frames.length > GIF_MAX_FRAMES || pixels > GIF_MAX_DECODED_PIXELS) throw new Error(ERROR_MESSAGES.tooLargeForBudget("This animation"));
  const gif = await (await Animation.decode(bytes)).encodeGIF();
  if (gif.length > ANIMATION_MAX_BYTES) throw new Error(ERROR_MESSAGES.tooLargeForBudget("This animation"));
  return Buffer.from(gif.buffer, gif.byteOffset, gif.byteLength);
}

const RASTER_CODECS: readonly ImageCodec[] = [
  {
    name: "PNG",
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
    passthrough: "image/png",
    size: (bytes) => pngHeader(bytes),
    decode: decodePngBytes,
    scaled: (bytes, width, height) => {
      const header = pngHeader(bytes);
      return header.interlaced ? null : decodePngScaled(bytes, header, width, height);
    },
  },
  {
    name: "JPEG",
    magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
    passthrough: "image/jpeg",
    size: displayedJpegSize,
    decode: decodeJpegBytes,
    orientation: exifOrientation,
  },
  {
    name: "GIF",
    magic: [ascii(0, "GIF8")],
    animation: { mimeType: "image/gif", frames: (bytes) => gifFrameCount(bytes, 2) },
    size: gifSize,
    decode: decodeGif,
  },
];

const DECODED_CODECS: readonly ImageCodec[] = [
  {
    name: "TIFF",
    magic: [ascii(0, "II*\0"), ascii(0, "MM\0*")],
    size: (bytes) => {
      const page = firstTiffPage(bytes);
      return { width: Number((page.t256 as number[])[0]), height: Number((page.t257 as number[])[0]) };
    },
    decode: (bytes) => {
      const page = firstTiffPage(bytes);
      assertDecodable(Number((page.t256 as number[])[0]), Number((page.t257 as number[])[0]));
      assertTiffData(bytes, page);
      UTIF.decodeImage(bytes, page);
      return { width: page.width, height: page.height, data: UTIF.toRGBA8(page) };
    },
  },
  {
    name: "HEIC",
    magic: [ascii(4, "ftypheic"), ascii(4, "ftypheix"), ascii(4, "ftypmif1")],
    size: heicSize,
    decode: async (bytes) => {
      const { width, height } = await heicSize(bytes);
      assertDecodable(width, height);
      const image = await heicCodec().one({ buffer: bytes });
      return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer) };
    },
  },
  {
    name: "WebP",
    magic: [ascii(8, "WEBPVP8")],
    animation: { mimeType: "image/webp", frames: webpFrameCount, gif: webpToGif },
    size: webpSize,
    decode: decodeWebp,
  },
];

export type ImageFamily = "raster" | "decoded";
const CODECS: Record<ImageFamily, readonly ImageCodec[]> = { raster: RASTER_CODECS, decoded: DECODED_CODECS };

function codecFor(bytes: Buffer, families: readonly ImageFamily[]): ImageCodec | undefined {
  return families
    .flatMap((family) => CODECS[family])
    .find((codec) => codec.magic.some((signature) => matchesMagic(signature, bytes)));
}

function requireCodec(bytes: Buffer, family: ImageFamily): ImageCodec {
  const codec = codecFor(bytes, [family]);
  if (!codec) throw new Error(ERROR_MESSAGES.unsupportedImage());
  return codec;
}

export async function imageSize(bytes: Buffer, family: ImageFamily): Promise<Size> {
  return sizeOf(requireCodec(bytes, family), bytes);
}

export function imageAnimation(bytes: Buffer, family: ImageFamily): { mimeType: AnimationMimeType; size: number } | undefined {
  const { animation } = requireCodec(bytes, family);
  if (!animation || bytes.length > ANIMATION_MAX_BYTES || animation.frames(bytes) < 2) return undefined;
  return { mimeType: animation.mimeType, size: bytes.length };
}

export async function animationAsGif(bytes: Buffer, family: ImageFamily): Promise<Buffer> {
  const codec = requireCodec(bytes, family);
  const gif = codec.animation?.gif;
  if (!gif) throw new Error(ERROR_MESSAGES.unsupportedImage(`${codec.name} to GIF conversion`));
  return guarded(codec, () => gif(bytes));
}

function passesThrough(codec: ImageCodec, bytes: Buffer, size: Size, fit: Fit): boolean {
  if (!codec.passthrough || bytes.length > fit.maxBytes || (codec.orientation?.(bytes) ?? 1) !== 1) return false;
  return targetScale(size.width, size.height, fit) === 1;
}

async function fitCodec(codec: ImageCodec, bytes: Buffer, size: Size, fit: Fit): Promise<EncodedImage> {
  if (passesThrough(codec, bytes, size, fit)) {
    return encoded(codec.passthrough!, size.width, size.height, bytes);
  }
  if (codec.scaled && size.width * size.height <= MAX_STREAMED_PIXELS) {
    const scale = targetScale(size.width, size.height, fit);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const scaled = codec.scaled(bytes, width, height);
    if (scaled) return fitRgba(await scaled, fit);
  }
  if (!codec.decode) throw new Error(ERROR_MESSAGES.unsupportedImage(`${codec.name} images`));
  assertDecodable(size.width, size.height);
  const decoded = await codec.decode(bytes);
  const orientation = codec.orientation?.(bytes) ?? 1;
  if (orientation === 1) return fitRgba(decoded, fit);
  const scale = targetScale(size.width, size.height, fit);
  const scaled = resize(decoded, Math.max(1, Math.round(decoded.width * scale)), Math.max(1, Math.round(decoded.height * scale)));
  return fitRgba(orient(scaled, orientation), fit);
}

async function sizeOf(codec: ImageCodec, bytes: Buffer): Promise<Size> {
  let size: Size;
  try {
    size = await codec.size(bytes);
  } catch (error) {
    if (errorCode(error)) throw error;
    console.error("[doc-viewer] image header:", error);
    throw new Error(ERROR_MESSAGES.imageDamaged(codec.name, "unreadable header"));
  }
  if (!(size.width > 0 && size.height > 0)) throw new Error(ERROR_MESSAGES.imageDamaged(codec.name, "invalid dimensions"));
  return size;
}

async function guarded<T>(codec: ImageCodec, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (errorCode(error)) throw error;
    console.error("[doc-viewer] image decode:", error);
    throw new Error(ERROR_MESSAGES.imageDamaged(codec.name, "the image data could not be decoded"));
  }
}

export async function renderImage(bytes: Buffer, family: ImageFamily, fit: Fit): Promise<EncodedImage> {
  const codec = requireCodec(bytes, family);
  const size = await sizeOf(codec, bytes);
  return guarded(codec, () => fitCodec(codec, bytes, size, fit));
}

// JPEG blurs a flat color by a step or two.
const ONE_COLOR_TOLERANCE = 2;

export async function oneColor(bytes: Buffer, budget: DecodeBudget): Promise<boolean> {
  const codec = codecFor(bytes, ["raster"]);
  if (!codec?.decode) return false;
  try {
    const size = await sizeOf(codec, bytes);
    if (!spend(budget, size.width * size.height)) return false;
    const { data } = await codec.decode(bytes);
    for (let i = 4; i < data.length; i++) if (Math.abs(data[i] - data[i % 4]) > ONE_COLOR_TOLERANCE) return false;
    return true;
  } catch {
    return false;
  }
}

export async function embeddedImage(bytes: Buffer, fit: Fit, budget: DecodeBudget): Promise<EncodedImage | string> {
  const codec = codecFor(bytes, ["raster", "decoded"]);
  if (!codec) return errorText(ERROR_MESSAGES.unsupportedImage());
  try {
    const size = await sizeOf(codec, bytes);
    const pixels = passesThrough(codec, bytes, size, fit) ? 0 : size.width * size.height;
    if (!spend(budget, pixels)) return errorText(ERROR_MESSAGES.imageBudgetExhausted());
    return await guarded(codec, () => fitCodec(codec, bytes, size, fit));
  } catch (error) {
    return errorText(error);
  }
}

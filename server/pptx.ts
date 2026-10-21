import { posix } from "node:path";
import { DEFAULT_RENDER_WIDTH_PX, MAX_RESPONSE_BYTES } from "../shared/limits";
import { ERROR_MESSAGES, errorText } from "../shared/errors";
import { decodeEntities } from "./html";
import { embeddedImage, oneColor } from "./images";
import { base64Capacity, decodeBudget, type EncodedImage, type Fit } from "./raster";
import { readEntry, readText, type ZipIndex } from "./zip";

export interface Deck {
  index: ZipIndex;
  slides: (string | null)[];
}

export interface Slide {
  texts: string[];
  images: EncodedImage[];
  omittedImages: number;
  omittedReasons: string[];
}

const SLIDE_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const TEXT_BUDGET_BYTES = SLIDE_BUDGET_BYTES / 2;
const MAX_TEXT_CHARS = 20_000;
export const SLIDE_TEXT_TRUNCATED = "More text on this slide is not shown";
const MAX_REASONS = 5;
// Start tags stop at the next "<" (never valid inside a tag) instead of scanning to the end of
// the part once per candidate, so a part of unclosed tags costs linear time.
const SLIDE_ID = /<(?:\w+:)?sldId\b[^<>]*?\b\w+:id="([^"]+)"/g;
const RELATIONSHIP = /<Relationship\b[^<>]*>/g;
const START_TAG_END = /[^<>]*>/y;
const RUN = /<a:t(?:\s[^<>]*)?>([^<]*)<\/a:t>|<a:br\b[^<>]*\/>/g;
const BLIP = /<a:blip\b[^<>]*?\br:(?:embed|link)="([^"]+)"/g;
const MARKER_BYTES = Buffer.byteLength(JSON.stringify(SLIDE_TEXT_TRUNCATED), "utf8") + 1;
const MISSING_IMAGE = "The picture is missing from the file";

const attribute = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

async function relationships(index: ZipIndex, part: string): Promise<Map<string, string>> {
  const rels = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
  const xml = (await readText(index, rels, "pptx")) ?? "";
  const targets = new Map<string, string>();
  for (const [tag] of xml.matchAll(RELATIONSHIP)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (!id || !target || attribute(tag, "TargetMode") === "External") continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));
  }
  return targets;
}

// Yields each <a:p> body up to the first "</a:p>" after its start tag. A lazy regex rescanned to
// the end of the slide once per unclosed "<a:p>"; indexOf stops at the first one that never closes.
function* paragraphs(xml: string): Generator<string> {
  let from = 0;
  for (let start = xml.indexOf("<a:p"); start >= 0; start = xml.indexOf("<a:p", from)) {
    from = start + 4;
    let gt = from;
    if (xml[gt] !== ">") {
      if (!/\s/.test(xml[gt] ?? "")) continue;
      START_TAG_END.lastIndex = gt;
      if (!START_TAG_END.test(xml)) continue;
      gt = START_TAG_END.lastIndex - 1;
      if (xml[gt - 1] === "/") continue;
    }
    const end = xml.indexOf("</a:p>", gt + 1);
    if (end < 0) return;
    yield xml.slice(gt + 1, end);
    from = end + 6;
  }
}

function boundedTexts(xml: string): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const body of paragraphs(xml)) {
    let text = "";
    for (const run of body.matchAll(RUN)) {
      text += run[1] === undefined ? "\n" : decodeEntities(run[1]);
      if (text.length > MAX_TEXT_CHARS) break;
    }
    if (text.trim() === "") continue;
    const clipped = text.slice(0, MAX_TEXT_CHARS);
    bytes += Buffer.byteLength(JSON.stringify(clipped), "utf8") + 1;
    if (bytes > TEXT_BUDGET_BYTES - MARKER_BYTES) {
      kept.push(SLIDE_TEXT_TRUNCATED);
      break;
    }
    kept.push(clipped);
  }
  return kept;
}

export async function loadDeck(index: ZipIndex): Promise<Deck> {
  const presentation = await readText(index, "ppt/presentation.xml", "pptx");
  if (presentation === null) throw new Error(ERROR_MESSAGES.invalidOffice("pptx"));
  const targets = await relationships(index, "ppt/presentation.xml");
  const slides = [...presentation.matchAll(SLIDE_ID)].map(([, id]) => targets.get(id) ?? null);
  return { index, slides };
}

export async function renderSlide(deck: Deck, slideIndex: number): Promise<Slide> {
  const part = deck.slides[slideIndex];
  const xml = part ? await readText(deck.index, part, "pptx") : null;
  if (!part || xml === null) return { texts: [], images: [], omittedImages: 0, omittedReasons: [] };
  const texts = boundedTexts(xml);
  const targets = await relationships(deck.index, part);
  const parts: (string | null)[] = [];
  const seen = new Set<string>();
  for (const [, rel] of xml.matchAll(BLIP)) {
    const target = targets.get(rel) ?? null;
    if (target !== null && seen.has(target)) continue;
    if (target !== null) seen.add(target);
    parts.push(target);
  }
  const budget = decodeBudget();
  let remaining = SLIDE_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(texts), "utf8");
  const images: EncodedImage[] = [];
  const reasons = new Set<string>();
  let omittedImages = 0;
  const omit = (reason: string) => {
    omittedImages++;
    if (reasons.size < MAX_REASONS) reasons.add(reason);
  };
  for (const [i, target] of parts.entries()) {
    let bytes: Buffer | null = null;
    try {
      bytes = target ? await readEntry(deck.index, target, "pptx") : null;
    } catch (error) {
      omit(errorText(error));
      continue;
    }
    if (!bytes) {
      omit(MISSING_IMAGE);
      continue;
    }
    const share = Math.floor(remaining / (parts.length - i)) - 256;
    if (share <= 0) {
      omit(errorText(ERROR_MESSAGES.tooLargeForBudget("Image")));
      continue;
    }
    const image = await embeddedImage(bytes, { maxWidth: DEFAULT_RENDER_WIDTH_PX, maxBytes: base64Capacity(share) }, budget);
    if (typeof image === "string") {
      omit(image);
      continue;
    }
    images.push(image);
    remaining -= image.data.length + 256;
  }
  return { texts, images, omittedImages, omittedReasons: [...reasons] };
}

// Search reads only text and never decodes slide images.
export async function readSlideTexts(deck: Deck, index: number): Promise<string[]> {
  const part = deck.slides[index];
  const xml = part ? await readText(deck.index, part, "pptx") : null;
  return xml === null ? [] : boundedTexts(xml);
}

export type SlidePreview =
  | { type: "image"; source: "saved-thumbnail" | "slide-picture"; image: EncodedImage }
  | { type: "title"; title: string };

const THUMBNAIL_RELATIONSHIP = /\/metadata\/thumbnail$/;
// The saved thumbnail may also be WMF or EMF, which nothing here decodes.
const DECODABLE_THUMBNAIL = /\.(?:jpe?g|png)$/i;
const FALLBACK_THUMBNAILS = ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png"];
const MAX_PREVIEW_PICTURES = 3;
const MAX_TITLE_CHARS = 200;
const TITLE_PLACEHOLDER = /<p:ph\b[^<>]*?\btype="(?:title|ctrTitle)"/;

async function savedThumbnail(index: ZipIndex): Promise<string | null> {
  const xml = (await readText(index, "_rels/.rels", "pptx")) ?? "";
  for (const [tag] of xml.matchAll(RELATIONSHIP)) {
    const target = attribute(tag, "Target");
    if (!target || !THUMBNAIL_RELATIONSHIP.test(attribute(tag, "Type") ?? "") || attribute(tag, "TargetMode") === "External") continue;
    const name = posix.normalize(target.startsWith("/") ? target.slice(1) : target);
    return DECODABLE_THUMBNAIL.test(name) && index.entries.has(name) ? name : null;
  }
  return FALLBACK_THUMBNAILS.find((name) => index.entries.has(name)) ?? null;
}

function slideTitle(xml: string): string {
  const placeholder = TITLE_PLACEHOLDER.exec(xml);
  let source = xml;
  if (placeholder) {
    const start = Math.max(xml.lastIndexOf("<p:sp>", placeholder.index), xml.lastIndexOf("<p:sp ", placeholder.index));
    const end = xml.indexOf("</p:sp>", placeholder.index);
    if (start >= 0 && end >= 0) source = xml.slice(start, end);
  }
  const text = boundedTexts(source).find((line) => line !== SLIDE_TEXT_TRUNCATED) ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

export async function firstSlidePreview(deck: Deck, fit: Fit): Promise<SlidePreview> {
  const budget = decodeBudget();
  const read = (name: string) => readEntry(deck.index, name, "pptx").catch(() => null);
  const picture = async (bytes: Buffer | null) => {
    if (!bytes) return null;
    const image = await embeddedImage(bytes, fit, budget);
    return typeof image === "string" ? null : image;
  };
  const saved = await savedThumbnail(deck.index);
  const savedBytes = saved ? await read(saved) : null;
  // python-pptx saves the same white picture in every deck, so a picture of one color shows nothing of it.
  const savedImage = savedBytes && !(await oneColor(savedBytes, budget)) ? await picture(savedBytes) : null;
  if (savedImage) return { type: "image", source: "saved-thumbnail", image: savedImage };
  const part = deck.slides[0];
  const xml = part ? await readText(deck.index, part, "pptx") : null;
  if (!part || xml === null) return { type: "title", title: "" };
  const targets = await relationships(deck.index, part);
  const tried = new Set<string>();
  for (const [, rel] of xml.matchAll(BLIP)) {
    const target = targets.get(rel);
    if (!target || tried.has(target)) continue;
    if (tried.size >= MAX_PREVIEW_PICTURES) break;
    tried.add(target);
    const image = await picture(await read(target));
    if (image) return { type: "image", source: "slide-picture", image };
  }
  return { type: "title", title: slideTitle(xml) };
}

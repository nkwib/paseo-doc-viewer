import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { decode, type Image } from "imagescript";
import { describe, expect, it, vi } from "vitest";
import { cacheKeys } from "../server/cache";
import { renderThumbnail } from "../server/documents";
import { heavy } from "../server/heavy";
import { thumbnailCacheKeys } from "../server/thumbnails";
import { thumbnailAnswer } from "../client/thumbnails";
import { errorCode } from "../shared/errors";
import { THUMBNAIL_MAX_WIDTH_PX } from "../shared/limits";
import { blankGrayPng, deckPptx, noisePng, solidPng } from "./fixtures/generators";
import { cpuTimed, workspace, workspaceWithFixtures } from "./helpers";
import { pptxEntries, rawZip, type RawEntry } from "./zip-builder";

vi.mock("../server/heavy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/heavy")>();
  return { ...actual, heavy: vi.fn(actual.heavy) };
});

vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("pptx previews run no external process");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

async function deckThumbnail(root: string, path: string, width = 160) {
  const thumbnail = await renderThumbnail({ root, path }, { index: 0, width });
  if (thumbnail.kind !== "pptx") throw new Error(`expected a deck preview, got ${thumbnail.kind}`);
  return thumbnail;
}

const jpeg = async (width: number, height: number) => Buffer.from(await ((await decode(noisePng(width, height))) as Image).encodeJPEG(80));
const wmf = Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0]);

describe("pptx first-slide previews", () => {
  it("use the picture saved with the deck first, bounded on both edges", async () => {
    const saved = { name: "docProps/thumbnail.jpeg", data: await jpeg(256, 192) };
    const root = workspace({ "saved.pptx": await deckPptx([{ title: "Q3", body: "x", images: [solidPng(40, 40, [255, 0, 0])] }], saved) });
    const thumbnail = await deckThumbnail(root, "saved.pptx");
    expect(thumbnail).toMatchObject({ slideCount: 1, preview: { type: "image", source: "saved-thumbnail" } });
    if (thumbnail.preview.type !== "image") throw new Error("expected an image");
    expect(thumbnail.preview.image).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
  });

  it("skip a saved picture of one color, as python-pptx saves, for slide 1's first picture or its title", async () => {
    const white = Buffer.from(await ((await decode(solidPng(256, 192, [255, 255, 255]))) as Image).encodeJPEG(80));
    const root = workspace({
      "picture.pptx": await deckPptx([{ title: "Cover", body: "x", images: [noisePng(400, 300)] }], { name: "docProps/thumbnail.jpeg", data: white }),
      "titled.pptx": await deckPptx([{ title: "Q3 board update", body: "x", titlePlaceholder: true }], { name: "docProps/thumbnail.png", data: solidPng(256, 192, [30, 58, 95]) }),
    });
    expect((await deckThumbnail(root, "picture.pptx")).preview).toMatchObject({ type: "image", source: "slide-picture" });
    expect((await deckThumbnail(root, "titled.pptx")).preview).toEqual({ type: "title", title: "Q3 board update" });
  });

  it("skip a WMF thumbnail and fall back to slide 1's first picture, then to its title", async () => {
    const saved = { name: "docProps/thumbnail.wmf", data: wmf };
    const root = workspace({
      "picture.pptx": await deckPptx([{ title: "Cover", body: "x", images: [noisePng(400, 300)] }, { title: "Two", body: "y" }], saved),
      "titled.pptx": await deckPptx([{ title: "Quarterly &amp; review", body: "First body line", titlePlaceholder: true }]),
      "blank.pptx": await deckPptx([{ title: "", body: "" }]),
    });
    expect(await deckThumbnail(root, "picture.pptx")).toMatchObject({ slideCount: 2, preview: { type: "image", source: "slide-picture", image: { width: 160, height: 120 } } });
    expect((await deckThumbnail(root, "titled.pptx")).preview).toEqual({ type: "title", title: "Quarterly & review" });
    expect((await deckThumbnail(root, "blank.pptx")).preview).toEqual({ type: "title", title: "" });
    expect((await deckThumbnail(workspaceWithFixtures("deck.pptx"), "deck.pptx")).preview).toEqual({ type: "title", title: "Slide 1" });
  });

  it("answer slide 1 only and are cached by revision", async () => {
    const root = workspace({ "deck.pptx": await deckPptx([{ title: "Old", body: "x" }]) });
    await expect(renderThumbnail({ root, path: "deck.pptx" }, { index: 1, width: 160 })).rejects.toThrow(/out of range|1/i);
    expect((await deckThumbnail(root, "deck.pptx")).preview).toEqual({ type: "title", title: "Old" });
    expect(thumbnailCacheKeys().some((key) => key.includes("deck.pptx"))).toBe(true);
    writeFileSync(join(root, "deck.pptx"), await deckPptx([{ title: "New", body: "x" }]));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "deck.pptx"), later, later);
    expect((await deckThumbnail(root, "deck.pptx")).preview).toEqual({ type: "title", title: "New" });
  });

  it("read the deck in a thumbnail lane, leaving foreground slots and the shared cache to the documents being read", async () => {
    const root = workspace({ "lane.pptx": await deckPptx([{ title: "Lane", body: "x" }, { title: "Two", body: "y" }]) });
    const calls = vi.mocked(heavy).mock.calls.length;
    expect(await deckThumbnail(root, "lane.pptx")).toMatchObject({ slideCount: 2, preview: { type: "title", title: "Lane" } });
    await renderThumbnail({ root, path: "lane.pptx" }, { index: 0, width: 120, keepOpen: false });
    expect(vi.mocked(heavy).mock.calls.slice(calls).map(([, options]) => options?.lane)).toEqual(["background", "idle"]);
    expect(cacheKeys().filter((key) => key.includes("lane.pptx"))).toEqual([]);
  });

  it("reach the client as a picture or a title, with the slide count", async () => {
    const root = workspace({ "titled.pptx": await deckPptx([{ title: "Plan", body: "x" }, { title: "b", body: "c" }]) });
    expect(thumbnailAnswer(await renderThumbnail({ root, path: "titled.pptx" }, { index: 0, width: 160 })).thumbnail).toEqual({ type: "title", title: "Plan", count: 2 });
  });
});

const MiB = 1024 * 1024;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const paragraph = (text: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const replaced = (entries: RawEntry[], name: string, data: RawEntry["data"]) => entries.map((entry) => (entry.name === name ? { name, data } : entry));

// Slide 1 is titled "Deck" and shows a picture per relationship target, in order.
function pictureDeck(targets: string[], extra: RawEntry[] = []): RawEntry[] {
  const pictures = targets.map((_, i) => `<p:pic><p:blipFill><a:blip r:embed="rId${i + 1}"/></p:blipFill></p:pic>`).join("");
  const rels = targets.map((target, i) => `<Relationship Id="rId${i + 1}" Type="${IMAGE}" Target="${target}"/>`).join("");
  return pptxEntries([paragraph("Deck") + pictures], [{ name: "ppt/slides/_rels/slide1.xml.rels", data: `${RELS}${rels}</Relationships>` }, ...extra]);
}

describe("pptx first-slide previews of hostile decks", () => {
  it("read pictures from inside the deck only, whatever the relationships point at", async () => {
    const root = workspace({ "outside.png": solidPng(40, 40, [255, 0, 0]) });
    const saved = `${RELS}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="../outside.png"/></Relationships>`;
    const escaping = replaced(pictureDeck(["../../../outside.png", `${root}/outside.png`, `file://${root}/outside.png`]), "_rels/.rels", saved);
    writeFileSync(join(root, "escaping.pptx"), rawZip(escaping));
    writeFileSync(join(root, "inside.pptx"), rawZip(pictureDeck(["../media/inside.png"], [{ name: "ppt/media/inside.png", data: solidPng(40, 40, [255, 0, 0]) }])));
    expect((await deckThumbnail(root, "escaping.pptx")).preview).toEqual({ type: "title", title: "Deck" });
    expect((await deckThumbnail(root, "inside.pptx")).preview).toMatchObject({ type: "image", source: "slide-picture" });
  });

  it("skip a picture that unpacks past its declared size, and refuse a deck that declares more than the limit", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bomb = { name: "ppt/media/bomb.png", deflated: deflateRawSync(Buffer.concat([noisePng(64, 48), Buffer.alloc(16 * MiB)])), declaredSize: 1024 };
      const declared = { name: "ppt/media/declared.png", data: "tiny", declaredSize: 200 * MiB };
      const root = workspace({ "bomb.pptx": rawZip(pictureDeck(["../media/bomb.png"], [bomb])), "declared.pptx": rawZip(pictureDeck(["../media/declared.png"], [declared])) });
      const { value, ms } = await cpuTimed(() => deckThumbnail(root, "bomb.pptx"));
      expect(value.preview).toEqual({ type: "title", title: "Deck" });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("bomb.png"), expect.objectContaining({ code: "ERR_BUFFER_TOO_LARGE" }));
      const refused = await cpuTimed(() => renderThumbnail({ root, path: "declared.pptx" }, { index: 0, width: 160 }).catch((error: unknown) => error));
      expect(errorCode(refused.value)).toBe("too_large");
      expect(ms + refused.ms).toBeLessThan(1_000);
    } finally {
      logged.mockRestore();
    }
  });

  it("refuse a picture by a header too large to decode, try three at most, and scale a large one to the thumbnail", async () => {
    // 20,000 x 20,000 by its header, past every decode limit, so it is refused before any decoding.
    const lying = blankGrayPng(1, 1);
    lying.writeUInt32BE(20_000, 16);
    lying.writeUInt32BE(20_000, 20);
    const root = workspace({
      "large.pptx": await deckPptx([{ title: "Huge", body: "x", images: [lying, blankGrayPng(7_000, 7_000)] }]),
      "title.pptx": await deckPptx([{ title: "Huge", body: "x", images: [lying, lying, lying, noisePng(80, 60)] }]),
    });
    const logged = vi.spyOn(console, "error");
    try {
      const large = await deckThumbnail(root, "large.pptx", 4_096);
      expect(large.preview).toMatchObject({ type: "image", source: "slide-picture", image: { width: THUMBNAIL_MAX_WIDTH_PX, height: THUMBNAIL_MAX_WIDTH_PX } });
      if (large.preview.type !== "image") throw new Error("expected an image");
      expect(Buffer.from(large.preview.image.data, "base64").length).toBeLessThanOrEqual(256 * 1024);
      expect((await deckThumbnail(root, "title.pptx")).preview).toEqual({ type: "title", title: "Huge" });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("read a malformed slide 1 as a title card of 200 characters at most", async () => {
    const titles: [string, Buffer, string][] = [
      ["unclosed", rawZip(pptxEntries(["<p:sp><p:txBody><a:p><a:r><a:t>Never closed"])), ""],
      ["binary", rawZip(replaced(pptxEntries([""]), "ppt/slides/slide1.xml", noisePng(32, 32))), ""],
      ["entities", rawZip(pptxEntries([paragraph("&#x110000;&#xD800;&bogus; &lt;b&gt;")])), "\uFFFD\uFFFD&bogus; <b>"],
      ["long", rawZip(pptxEntries([paragraph("A".repeat(50_000))])), "A".repeat(200)],
      ["runs", rawZip(pptxEntries([`<a:p>${"<a:r><a:t>ab </a:t></a:r>".repeat(50_000)}</a:p>`])), "ab ".repeat(67).slice(0, 200)],
      ["rels", rawZip(replaced(pictureDeck(["../media/a.png"], [{ name: "ppt/media/a.png", data: solidPng(8, 8, [0, 0, 255]) }]), "ppt/slides/_rels/slide1.xml.rels", `${RELS}<Relationship Id="rId1" Target="../media/a.png"`)), "Deck"],
      ["unlinked", rawZip(pptxEntries(["x"]).filter((entry) => entry.name !== "ppt/_rels/presentation.xml.rels")), ""],
    ];
    const root = workspace(Object.fromEntries(titles.map(([name, deck]) => [`${name}.pptx`, deck])));
    for (const [name, , title] of titles) {
      const thumbnail = await deckThumbnail(root, `${name}.pptx`);
      expect({ name, slideCount: thumbnail.slideCount, preview: thumbnail.preview }).toEqual({ name, slideCount: 1, preview: { type: "title", title } });
    }
  });
});

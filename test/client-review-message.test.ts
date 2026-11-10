import { describe, expect, it } from "vitest";
import { formatReview, noteRevisionStatus } from "../client/review-message";
import { createReviewDrafts, pageImageKey } from "../client/review-draft";
import { documentRevision, revisionModifiedAt, revisionSize } from "../shared/revision";

const modified = Date.UTC(2026, 9, 17, 14, 2, 31, 250);
const current = documentRevision(52_000, modified, modified);
const previous = documentRevision(48_000, modified - 3_600_000, modified - 3_600_000);
const image = { mimeType: "image/png" as const, width: 1414, height: 2000, data: "iVBORw0KGgo" };

function sampleDraft() {
  const drafts = createReviewDrafts();
  const legend = drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 3, text: "Legend overlaps the axis" })!;
  drafts.addNote("ws", { path: "out/appendix.pdf", revision: "opaque", page: 0, text: "Typo in the heading" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: previous, page: 1, text: "Title is too long" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 6, text: "Move this table\nonto its own page" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 0, text: "Cover is fine, but add the date" });
  drafts.attachImage("ws", pageImageKey(legend), image);
  return drafts.get("ws");
}

describe("review message", () => {
  it("distinguishes slide notes, preserves revision warnings, and never attaches slide images or PDF pins", () => {
    const drafts = createReviewDrafts();
    const slide = drafts.addNote("ws", { path: "deck.pptx", revision: previous, page: 6, unit: "slide", text: "Shorten this title\nand enlarge the chart" })!;
    expect(drafts.attachImage("ws", pageImageKey(slide), image)).toBe(false);
    drafts.addNote("ws", { path: "report.pdf", revision: current, page: 0, text: "Check the date" });
    const message = formatReview(drafts.get("ws"), () => current, () => "PDF pin");
    expect(message.text).toContain("notes by page or slide (numbered from 1)");
    expect(message.text).toContain('"deck.pptx", older version');
    expect(message.text).toContain("the file has changed since these notes");
    expect(message.text).toContain("- Slide 7: Shorten this title\n  and enlarge the chart");
    expect(message.text).not.toContain("Slide 7 (pinned");
    expect(message.text).toContain('- Page 1 (pinned as "PDF pin"): Check the date');
    expect(message.images).toEqual([]);
  });

  it("round-trips the modified time encoded in a document revision", () => {
    expect(revisionModifiedAt(current)).toBe(modified);
    expect(revisionModifiedAt("opaque")).toBeNull();
    expect(revisionSize(current)).toBe(52_000);
    expect(revisionSize("opaque")).toBeNull();
  });

  it("marks a note as older once the file's displayed revision moves on", () => {
    const note = { path: "a.pdf", revision: previous, page: 0 };
    expect(noteRevisionStatus(note, previous)).toBe("current");
    expect(noteRevisionStatus(note, current)).toBe("older");
    expect(noteRevisionStatus(note, undefined)).toBe("unknown");
  });

  it("groups notes by file and revision, pages in order, older revisions after current ones", () => {
    const revisions = new Map([["out/report.pdf", current]]);
    const message = formatReview(sampleDraft(), (path) => revisions.get(path));
    expect(message.text).toBe(
      [
        "Review notes from the document viewer. Each file name is quoted as a JSON string and gives the modified time and size of the version I was viewing, then my notes by page (numbered from 1).",
        "",
        "\"out/report.pdf\" (modified 2026-10-17 14:02:31 UTC, 52,000 bytes)",
        "- Page 1: Cover is fine, but add the date",
        "- Page 4: Legend overlaps the axis [image 1]",
        "- Page 7: Move this table",
        "  onto its own page",
        "",
        "\"out/report.pdf\", older version (modified 2026-10-17 13:02:31 UTC, 48,000 bytes); the file has changed since these notes",
        "- Page 2: Title is too long",
        "",
        "\"out/appendix.pdf\"",
        "- Page 1: Typo in the heading",
        "",
        "Attached images:",
        "1. \"out/report.pdf\" page 4 (modified 2026-10-17 14:02:31 UTC, 52,000 bytes)",
      ].join("\n"),
    );
    expect(message.text).not.toContain(current);
    expect(message.images).toEqual([{ data: image.data, mimeType: image.mimeType }]);
  });

  it("names a pinned page by its pin label, on one line", () => {
    const drafts = createReviewDrafts();
    drafts.addNote("ws", { path: "a.pdf", revision: current, page: 3, text: "Safety looks wrong" });
    drafts.addNote("ws", { path: "a.pdf", revision: current, page: 4, text: "Fine" });
    const pins = [{ path: "a.pdf", index: 3, revision: current, label: "Category\nheatmap" }, { path: "a.pdf", index: 4, revision: previous, label: "Stale pin" }];
    const message = formatReview(drafts.get("ws"), () => current,
      (note) => pins.find((pin) => pin.path === note.path && pin.index === note.page && pin.revision === note.revision)?.label);
    expect(message.text).toContain('- Page 4 (pinned as "Category heatmap"): Safety looks wrong');
    expect(message.text).toContain("- Page 5: Fine");
  });

  it("omits the image section when no page is attached", () => {
    const drafts = createReviewDrafts();
    drafts.addNote("ws", { path: "a.pdf", revision: current, page: 0, text: "Fine" });
    const message = formatReview(drafts.get("ws"), () => current);
    expect(message.text.endsWith("- Page 1: Fine")).toBe(true);
    expect(message.images).toEqual([]);
  });
});

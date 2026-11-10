import { describe, expect, it, vi } from "vitest";
import { createReviewDrafts, emptyNotePage, pageImageKey, reviewScope, sharedReviewDrafts } from "../client/review-draft";
import { REVIEW_IMAGE_MAX_BASE64_CHARS, REVIEW_IMAGE_MAX_EDGE_PX, REVIEW_MAX_IMAGES, REVIEW_MAX_NOTE_CHARS, REVIEW_MAX_NOTES } from "../shared/limits";

const note = (page: number, text = `note ${page}`) => ({ path: "out/report.pdf", revision: "r1", page, text });
const image = { mimeType: "image/png" as const, width: 10, height: 10, data: "AAAA" };

describe("review draft store", () => {
  it("keeps notes per workspace and notifies subscribers", () => {
    const drafts = createReviewDrafts();
    const listener = vi.fn();
    drafts.subscribe(listener);
    drafts.addNote("ws-1", note(3));
    drafts.addNote("ws-1", note(6));
    drafts.addNote("ws-2", note(0));
    expect(drafts.get("ws-1").notes.map((entry) => [entry.page, entry.text])).toEqual([[3, "note 3"], [6, "note 6"]]);
    expect(drafts.get("ws-2").notes).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("returns the same snapshot until the workspace's draft changes", () => {
    const drafts = createReviewDrafts();
    expect(drafts.get("ws-1")).toBe(drafts.get("ws-1"));
    drafts.addNote("ws-1", note(1));
    const before = drafts.get("ws-1");
    drafts.addNote("ws-2", note(1));
    expect(drafts.get("ws-1")).toBe(before);
  });

  it("edits and removes notes, ignoring blank text", () => {
    const drafts = createReviewDrafts();
    const first = drafts.addNote("ws-1", note(1))!;
    drafts.addNote("ws-1", note(2));
    expect(drafts.addNote("ws-1", note(3, "   "))).toBeNull();
    drafts.editNote("ws-1", first.id, "  Legend overlaps the axis  ");
    expect(drafts.get("ws-1").notes[0]!.text).toBe("Legend overlaps the axis");
    drafts.editNote("ws-1", first.id, " ");
    expect(drafts.get("ws-1").notes[0]!.text).toBe("Legend overlaps the axis");
    drafts.removeNote("ws-1", first.id);
    expect(drafts.get("ws-1").notes.map((entry) => entry.page)).toEqual([2]);
  });

  it("bounds the number of notes and the note length", () => {
    const drafts = createReviewDrafts();
    for (let page = 0; page < REVIEW_MAX_NOTES; page++) expect(drafts.addNote("ws-1", note(page))).not.toBeNull();
    expect(drafts.addNote("ws-1", note(99))).toBeNull();
    expect(drafts.get("ws-1").notes).toHaveLength(REVIEW_MAX_NOTES);
    const long = createReviewDrafts().addNote("ws-1", note(1, "x".repeat(REVIEW_MAX_NOTE_CHARS + 50)))!;
    expect(long.text).toHaveLength(REVIEW_MAX_NOTE_CHARS);
  });

  it("attaches one image per page revision, bounded in count, dropped with its last note", () => {
    const drafts = createReviewDrafts();
    const a = drafts.addNote("ws-1", note(1))!;
    const b = drafts.addNote("ws-1", note(1, "second note on the same page"))!;
    const key = pageImageKey(a);
    expect(pageImageKey(b)).toBe(key);
    expect(drafts.attachImage("ws-1", key, image)).toBe(true);
    drafts.removeNote("ws-1", a.id);
    expect(drafts.get("ws-1").images[key]).toEqual(image);
    drafts.removeNote("ws-1", b.id);
    expect(drafts.get("ws-1").images[key]).toBeUndefined();
    for (let page = 0; page <= REVIEW_MAX_IMAGES; page++) drafts.addNote("ws-1", note(page));
    const keys = drafts.get("ws-1").notes.map(pageImageKey);
    keys.slice(0, REVIEW_MAX_IMAGES).forEach((each) => expect(drafts.attachImage("ws-1", each, image)).toBe(true));
    expect(drafts.attachImage("ws-1", keys[REVIEW_MAX_IMAGES]!, image)).toBe(false);
    drafts.detachImage("ws-1", keys[0]!);
    expect(drafts.attachImage("ws-1", keys[REVIEW_MAX_IMAGES]!, image)).toBe(true);
  });

  it("refuses an image for a page no note refers to", () => {
    const drafts = createReviewDrafts();
    expect(drafts.attachImage("ws-1", pageImageKey(note(4)), image)).toBe(false);
  });

  it("clears a workspace's draft", () => {
    const drafts = createReviewDrafts();
    const added = drafts.addNote("ws-1", note(1))!;
    drafts.attachImage("ws-1", pageImageKey(added), image);
    drafts.clear("ws-1");
    expect(drafts.get("ws-1")).toEqual({ notes: [], images: {} });
  });

  it("removes only the notes that were sent, keeping notes added meanwhile", () => {
    const drafts = createReviewDrafts();
    const sent = drafts.addNote("ws-1", note(1))!;
    drafts.attachImage("ws-1", pageImageKey(sent), image);
    const later = drafts.addNote("ws-1", note(2))!;
    drafts.removeNotes("ws-1", [sent.id]);
    expect(drafts.get("ws-1").notes).toEqual([later]);
    expect(drafts.get("ws-1").images).toEqual({});
  });

  it("refuses page images over the edge or size bound", () => {
    const drafts = createReviewDrafts();
    const key = pageImageKey(drafts.addNote("ws-1", note(1))!);
    expect(drafts.attachImage("ws-1", key, { ...image, width: REVIEW_IMAGE_MAX_EDGE_PX + 1 })).toBe(false);
    expect(drafts.attachImage("ws-1", key, { ...image, height: REVIEW_IMAGE_MAX_EDGE_PX + 1 })).toBe(false);
    expect(drafts.attachImage("ws-1", key, { ...image, data: "A".repeat(REVIEW_IMAGE_MAX_BASE64_CHARS + 4) })).toBe(false);
    expect(drafts.attachImage("ws-1", key, { ...image, width: REVIEW_IMAGE_MAX_EDGE_PX, height: REVIEW_IMAGE_MAX_EDGE_PX })).toBe(true);
  });

  it("shares one store across evaluations of the plugin bundle in the same app", () => {
    const global = {};
    const first = sharedReviewDrafts(global);
    first.addNote(reviewScope("host-a", "ws-1"), note(1));
    expect(sharedReviewDrafts(global)).toBe(first);
    expect(sharedReviewDrafts(global).get(reviewScope("host-a", "ws-1")).notes).toHaveLength(1);
    expect(sharedReviewDrafts(global).get(reviewScope("host-b", "ws-1")).notes).toHaveLength(0);
    expect(sharedReviewDrafts({})).not.toBe(first);
  });
});

describe("note being typed", () => {
  it("is kept per document until it is cleared, and an empty one is not kept", () => {
    const drafts = createReviewDrafts();
    drafts.setComposing("ws", "a.pdf", { revision: "r1", page: 2, text: "Half typed" });
    expect(drafts.composing("ws", "a.pdf")).toEqual({ revision: "r1", page: 2, text: "Half typed" });
    expect(drafts.composing("ws", "b.pdf")).toBeUndefined();
    expect(drafts.composing("other", "a.pdf")).toBeUndefined();
    expect(drafts.get("ws").notes).toEqual([]);
    drafts.setComposing("ws", "a.pdf", { revision: "r1", page: 2, text: "   " });
    expect(drafts.composing("ws", "a.pdf")).toBeUndefined();
    drafts.setComposing("ws", "a.pdf", { revision: "r1", page: 2, text: "x" });
    drafts.setComposing("ws", "a.pdf", null);
    expect(drafts.composing("ws", "a.pdf")).toBeUndefined();
  });

  it("keeps at most 50 documents' notes, dropping the oldest", () => {
    const drafts = createReviewDrafts();
    for (let index = 0; index <= 50; index++) drafts.setComposing("ws", `${index}.pdf`, { revision: "r", page: 0, text: "t" });
    expect(drafts.composing("ws", "0.pdf")).toBeUndefined();
    expect(drafts.composing("ws", "50.pdf")).toBeDefined();
  });

  it("moves an empty editor to the last page a rewrite left, or closes it when none is left", () => {
    expect(emptyNotePage(1, 3)).toBe(1);
    expect(emptyNotePage(2, 1)).toBe(0);
    expect(emptyNotePage(4, 3)).toBe(2);
    expect(emptyNotePage(0, 0)).toBeNull();
  });
});

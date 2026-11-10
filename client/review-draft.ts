import { useSyncExternalStore } from "react";
import { REVIEW_IMAGE_MAX_BASE64_CHARS, REVIEW_IMAGE_MAX_EDGE_PX, REVIEW_MAX_IMAGES, REVIEW_MAX_NOTE_CHARS, REVIEW_MAX_NOTES } from "../shared/limits";

// Review drafts live only in app memory. The host evaluates this bundle again when it
// reconnects to a daemon, so the store hangs off the app's global object, keyed by host and
// workspace, and lasts until the app reloads.

export type ReviewUnit = "page" | "slide";

export interface ReviewNote {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
  readonly page: number;
  /** Omitted on PDF drafts created by an older client bundle in this app session. */
  readonly unit?: ReviewUnit;
  readonly text: string;
}

export interface PageImage {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

export interface ReviewDraft {
  readonly notes: readonly ReviewNote[];
  readonly images: Readonly<Record<string, PageImage>>;
}

const EMPTY: ReviewDraft = { notes: [], images: {} };

export function reviewUnit(note: { readonly unit?: ReviewUnit }): ReviewUnit {
  return note.unit ?? "page";
}

export function noteLocation(note: Pick<ReviewNote, "page" | "unit">): string {
  return `${reviewUnit(note) === "slide" ? "Slide" : "Page"} ${note.page + 1}`;
}

export function pageImageKey({ path, revision, page, unit }: Pick<ReviewNote, "path" | "revision" | "page" | "unit">): string {
  return `${path}\0${revision}\0${page}${unit === "slide" ? "\0slide" : ""}`;
}

// An editor with no text yet follows the file: it keeps its page while that page exists, else
// moves to the last one, where the viewer lands too. A file with no pages closes it.
export function emptyNotePage(page: number, count: number): number | null {
  return count > 0 ? Math.min(page, count - 1) : null;
}

export function reviewScope(hostId: string | undefined, workspaceId: string): string {
  return `${hostId ?? ""}\0${workspaceId}`;
}

function withinBounds(image: PageImage): boolean {
  return image.width <= REVIEW_IMAGE_MAX_EDGE_PX && image.height <= REVIEW_IMAGE_MAX_EDGE_PX && image.data.length <= REVIEW_IMAGE_MAX_BASE64_CHARS;
}

// Text typed in the note composer but not added yet, one per document. Kept beside the draft so a
// workspace switch, which unmounts the viewer, does not lose it. Not part of the sent review.
export interface ComposingNote {
  readonly revision: string;
  readonly page: number;
  readonly unit?: ReviewUnit;
  readonly text: string;
}

const MAX_COMPOSING = 50;

export function createReviewDrafts() {
  const drafts = new Map<string, ReviewDraft>();
  const composing = new Map<string, ComposingNote>();
  const listeners = new Set<() => void>();
  let serial = 0;
  const get = (scope: string) => drafts.get(scope) ?? EMPTY;
  const set = (scope: string, draft: ReviewDraft) => {
    if (draft.notes.length === 0) drafts.delete(scope);
    else drafts.set(scope, draft);
    for (const listener of listeners) listener();
  };
  const withNotes = (draft: ReviewDraft, notes: readonly ReviewNote[]): ReviewDraft => {
    const kept = new Set(notes.map(pageImageKey));
    const images = Object.fromEntries(Object.entries(draft.images).filter(([key]) => kept.has(key)));
    return { notes, images };
  };
  const clean = (text: string) => text.trim().slice(0, REVIEW_MAX_NOTE_CHARS);

  return {
    get,
    composing: (scope: string, path: string): ComposingNote | undefined => composing.get(`${scope}\0${path}`),
    // Not observed by React: the composer reads it once when it opens.
    setComposing(scope: string, path: string, note: ComposingNote | null) {
      const key = `${scope}\0${path}`;
      composing.delete(key);
      if (!note || !note.text.trim()) return;
      composing.set(key, { ...note, text: note.text.slice(0, REVIEW_MAX_NOTE_CHARS) });
      if (composing.size > MAX_COMPOSING) composing.delete(composing.keys().next().value!);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    addNote(scope: string, input: Omit<ReviewNote, "id">): ReviewNote | null {
      const draft = get(scope);
      const text = clean(input.text);
      if (!text || draft.notes.length >= REVIEW_MAX_NOTES) return null;
      const note = { ...input, id: `note-${++serial}`, text };
      set(scope, { ...draft, notes: [...draft.notes, note] });
      return note;
    },
    editNote(scope: string, id: string, value: string) {
      const draft = get(scope);
      const text = clean(value);
      if (!text) return;
      set(scope, { ...draft, notes: draft.notes.map((note) => (note.id === id ? { ...note, text } : note)) });
    },
    removeNote(scope: string, id: string) {
      const draft = get(scope);
      set(scope, withNotes(draft, draft.notes.filter((note) => note.id !== id)));
    },
    removeNotes(scope: string, ids: readonly string[]) {
      const draft = get(scope);
      const removed = new Set(ids);
      set(scope, withNotes(draft, draft.notes.filter((note) => !removed.has(note.id))));
    },
    attachImage(scope: string, key: string, image: PageImage): boolean {
      const draft = get(scope);
      if (!withinBounds(image) || !draft.notes.some((note) => reviewUnit(note) === "page" && pageImageKey(note) === key)) return false;
      if (!(key in draft.images) && Object.keys(draft.images).length >= REVIEW_MAX_IMAGES) return false;
      set(scope, { ...draft, images: { ...draft.images, [key]: image } });
      return true;
    },
    detachImage(scope: string, key: string) {
      const draft = get(scope);
      if (!(key in draft.images)) return;
      const { [key]: _removed, ...images } = draft.images;
      set(scope, { ...draft, images });
    },
    clear(scope: string) {
      set(scope, EMPTY);
    },
  };
}

export type ReviewDrafts = ReturnType<typeof createReviewDrafts>;

const STORE_KEY = Symbol.for("paseo-doc-viewer/review-drafts/v1");

export function sharedReviewDrafts(global: object): ReviewDrafts {
  const holder = global as { [STORE_KEY]?: ReviewDrafts };
  return (holder[STORE_KEY] ??= createReviewDrafts());
}

export const reviewDrafts = sharedReviewDrafts(globalThis);

export function useReviewDraft(scope: string): ReviewDraft {
  return useSyncExternalStore(reviewDrafts.subscribe, () => reviewDrafts.get(scope), () => reviewDrafts.get(scope));
}

import { searchCursor, searchMatch } from "./search";
import { documentRevision, pagePins, pinLabel, reviewMark, viewerPosition } from "./viewer-state";
import { defineRpc } from "@getpaseo/plugin";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { DOCUMENT_GROUPS, RECENT_CUTS } from "./browse";
import { documentView, documentViews } from "./documents-view";
import { DOCUMENT_KINDS } from "./kinds";
import { OPENED_REVISIONS_MAX_PATHS, THUMBNAIL_MAX_WIDTH_PX, THUMBNAIL_MIN_WIDTH_PX } from "./limits";

// Kinds shown in the sheet grid. JSON Lines and Parquet have named columns instead of a header row.
export const SHEET_KINDS = ["xlsx", "csv", "jsonl", "parquet"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

const documentRef = { workspaceId: z.string().min(1), path: z.string().min(1) };
const password = z.string().min(1).max(1024).optional();
const revision = z.string();
const animationMimeType = z.enum(["image/gif", "image/webp"]);
const encodedImage = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string(),
});

export const docOpenRpc = defineRpc({
  name: "doc.open",
  input: z.object({ ...documentRef, password }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pdf"), revision, pageCount: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("docx"), revision }),
    z.object({
      kind: z.enum(SHEET_KINDS),
      revision,
      sheets: z.array(
        z.object({
          name: z.string(),
          rowCount: z.number().int().nonnegative(),
          columnCount: z.number().int().nonnegative(),
          countsApproximate: z.boolean().optional(),
        }),
      ),
      sheetsTruncated: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("pptx"), revision, slideCount: z.number().int().nonnegative() }),
    z.object({ kind: z.enum(["video", "audio"]), revision, mimeType: z.string(), size: z.number().int().nonnegative() }),
    z.object({
      kind: z.enum(["image-raster", "image-decoded"]),
      revision,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      animation: z.object({ mimeType: animationMimeType, size: z.number().int().positive() }).optional(),
    }),
  ]),
});

export const docPageRpc = defineRpc({
  name: "doc.page",
  input: z.object({
    ...documentRef,
    password,
    index: z.number().int().nonnegative(),
    maxWidth: z.number().int().positive().optional(),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pdf"),
      revision,
      index: z.number().int().nonnegative(),
      pageCount: z.number().int().nonnegative(),
      image: encodedImage,
    }),
    z.object({
      kind: z.literal("pptx"),
      revision,
      index: z.number().int().nonnegative(),
      slideCount: z.number().int().nonnegative(),
      texts: z.array(z.string()),
      images: z.array(encodedImage),
      omittedImages: z.number().int().nonnegative(),
      omittedReasons: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.enum(["image-raster", "image-decoded"]),
      revision,
      sourceWidth: z.number().int().positive(),
      sourceHeight: z.number().int().positive(),
      image: encodedImage,
    }),
  ]),
});

export const docThumbnailRpc = defineRpc({
  name: "doc.thumbnail",
  input: z.object({
    ...documentRef,
    password,
    index: z.number().int().nonnegative(),
    width: z.number().int().min(THUMBNAIL_MIN_WIDTH_PX).max(THUMBNAIL_MAX_WIDTH_PX),
    // False for a turn card's one page of files nobody is reading: a PDF is not kept open for later pages.
    keepOpen: z.boolean().optional(),
    // The revision the caller lists: a file changed since fails with fileChanged after a stat, unrendered.
    revision: revision.optional(),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pdf"),
      revision,
      index: z.number().int().nonnegative(),
      pageCount: z.number().int().nonnegative(),
      image: encodedImage,
    }),
    z.object({ kind: z.enum(["image-raster", "image-decoded"]), revision, image: encodedImage }),
    // A preview, not a rendered slide: the picture saved with the file, slide 1's first picture, or its title.
    z.object({
      kind: z.literal("pptx"),
      revision,
      slideCount: z.number().int().nonnegative(),
      preview: z.discriminatedUnion("type", [
        z.object({ type: z.literal("image"), source: z.enum(["saved-thumbnail", "slide-picture"]), image: encodedImage }),
        z.object({ type: z.literal("title"), title: z.string().max(200) }),
      ]),
    }),
  ]),
});

export const docTextRpc = defineRpc({
  name: "doc.text",
  input: z.object({ ...documentRef, password, index: z.number().int().nonnegative() }),
  output: z.object({
    kind: z.literal("pdf"),
    revision,
    index: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
  }),
});

// `raw` is the stored value (the text for shared strings), null when nothing is stored; a formula
// without a stored value has no saved result. A shared formula's text is null when it cannot be derived.
export const cellDetail = z.object({
  type: z.enum(["n", "s", "b", "e", "d", "str", "inlineStr", "text", "json", "parquet"]),
  raw: z.string().nullable(),
  display: z.string(),
  // The stored value is longer than `raw` and `display` show; doc.cell returns it in full.
  truncated: z.boolean().optional(),
  // JSON Lines: the value's JSON type, its key path, the line it came from and why the line is unreadable.
  valueType: z.string().optional(),
  keyPath: z.string().optional(),
  // Parquet: the column's declared type.
  columnType: z.string().optional(),
  line: z.number().int().positive().optional(),
  error: z.string().optional(),
  numberFormat: z.string().optional(),
  formula: z.object({
    kind: z.enum(["normal", "shared", "array", "dataTable"]),
    text: z.string().nullable(),
    cached: z.boolean(),
    master: z.string().optional(),
    masterText: z.string().optional(),
    range: z.string().optional(),
    truncated: z.boolean().optional(),
  }).optional(),
});
export type CellDetail = z.infer<typeof cellDetail>;

export const docRowsRpc = defineRpc({
  name: "doc.rows",
  input: z.object({
    ...documentRef,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    maxColumns: z.number().int().positive().optional(),
    maxRows: z.number().int().positive().optional(),
    detail: z.boolean().optional(),
  }),
  output: z.object({
    kind: z.enum(SHEET_KINDS),
    revision,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    countsApproximate: z.boolean().optional(),
    rows: z.array(z.array(z.string())),
    details: z.array(z.array(cellDetail.nullable())).optional(),
    // Names of the returned columns, for kinds whose columns are named by the file.
    columnNames: z.array(z.string()).optional(),
    nextRowOffset: z.number().int().nonnegative().nullable(),
    nextColumnOffset: z.number().int().nonnegative().nullable(),
  }),
});

// One cell's stored value in full (up to CELL_FULL_MAX_CHARS), for values the grid cuts short. With `column`
// null it returns the whole record as JSON (JSON Lines and Parquet only).
export const docCellRpc = defineRpc({
  name: "doc.cell",
  input: z.object({
    ...documentRef,
    sheet: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative().nullable(),
  }),
  output: z.object({
    revision,
    text: z.string(),
    format: z.enum(["text", "json"]),
    truncated: z.boolean(),
    // Length in characters of the whole value, when known.
    length: z.number().int().nonnegative().optional(),
    line: z.number().int().positive().optional(),
  }),
});
export type DocCellOutput = RpcOutput<typeof docCellRpc>;

const issuesCursor = z.object({ revision, sheet: z.number().int().nonnegative(), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() });

export const docIssuesRpc = defineRpc({
  name: "doc.issues",
  input: z.object({ ...documentRef, cursor: issuesCursor.nullable().optional() }),
  output: z.object({
    revision,
    issues: z.array(z.object({
      sheet: z.number().int().nonnegative(),
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
      // JSON Lines: "invalid-json" is an unreadable line; "unlisted-key" is a key first seen after the column sample.
      kind: z.enum(["error", "missing-result", "invalid-json", "unlisted-key"]),
      display: z.string(),
      formula: z.string().nullable(),
      line: z.number().int().positive().optional(),
    })),
    // Issues found but not listed because the list is full.
    omitted: z.number().int().nonnegative().optional(),
    // Rows [fromRow, toRow) of each sheet were fully inspected by this call.
    inspected: z.array(z.object({ sheet: z.number().int().nonnegative(), fromRow: z.number().int().nonnegative(), toRow: z.number().int().nonnegative() })),
    next: issuesCursor.nullable(),
    stopped: z.enum(["time", "rows", "issues"]).nullable(),
  }),
});
export type DocIssuesOutput = RpcOutput<typeof docIssuesRpc>;

const docBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), text: z.string() }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("table"), rows: z.array(z.array(z.string())) }),
  z.object({ type: z.literal("image"), alt: z.string(), image: encodedImage }),
  z.object({ type: z.literal("omitted-image"), alt: z.string(), reason: z.string() }),
]);
export type DocBlock = z.infer<typeof docBlock>;

export const docBlocksRpc = defineRpc({
  name: "doc.blocks",
  input: z.object({ ...documentRef, cursor: z.number().int().nonnegative() }),
  output: z.object({
    kind: z.literal("docx"),
    revision,
    blocks: z.array(docBlock),
    nextCursor: z.number().int().nonnegative().nullable(),
  }),
});

export const mediaChunkRpc = defineRpc({
  name: "media.chunk",
  input: z.object({
    ...documentRef,
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive(),
    mimeType: animationMimeType.optional(),
  }),
  output: z.object({
    kind: z.enum(["video", "audio", "image-raster", "image-decoded"]),
    revision,
    mimeType: z.string(),
    offset: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    data: z.string(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
});

export const docsRecentRpc = defineRpc({
  name: "docs.recent",
  input: z.object({
    workspaceId: z.string().min(1),
    // 50 unless asked; more than RECENT_MAX_LIMIT is read as RECENT_MAX_LIMIT.
    limit: z.number().int().positive().optional(),
    query: z.string().max(200).optional(),
    group: z.enum(DOCUMENT_GROUPS).optional(),
    needsReview: z.boolean().optional(),
    // When Documents was last opened in this workspace (from docs.visit); files changed later are new
    // unless reviewed, or opened in the viewer at their current revision.
    newSince: z.number().nonnegative().optional(),
    newOnly: z.boolean().optional(),
    // The version of the list the client holds: while it is current the daemon answers { unchanged: true }.
    // Older daemons ignore it and send the list.
    since: z.string().max(64).optional(),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(DOCUMENT_KINDS),
        mtimeMs: z.number(),
        size: z.number().int().nonnegative(),
        // The file's revision as doc.open would report it, so thumbnails can be keyed without opening the file.
        revision,
        review: z.enum(["reviewed", "changed"]).optional(),
        isNew: z.literal(true).optional(),
      }),
    ),
    truncated: z.boolean(),
    // Sent when truncated, every reason that applies (see RECENT_CUTS). Older daemons send none.
    truncatedBy: z.array(z.enum(RECENT_CUTS)).min(1).optional(),
    counts: z.record(z.enum(DOCUMENT_GROUPS), z.number().int().nonnegative()),
    needsReview: z.number().int().nonnegative(),
    newCount: z.number().int().nonnegative(),
    // Up to 3 files matching the query that the viewer cannot open, sent only when no document matched.
    unsupported: z.array(z.string()).max(3).optional(),
    // Changes whenever anything above does. Older daemons send none.
    version: z.string().max(64).optional(),
  }).or(z.object({ unchanged: z.literal(true), version: z.string().max(64) })),
});

// Records that Documents was opened in a workspace and returns the previous time, or null the first time.
export const docsVisitRpc = defineRpc({
  name: "docs.visit",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ since: z.number().nonnegative().nullable() }),
});

export const docsAnyRpc = defineRpc({
  name: "docs.any",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ found: z.boolean() }),
});

export const fileInfoRpc = defineRpc({
  name: "file.info", input: z.object(documentRef),
  output: z.object({ revision, size: z.number().int().nonnegative(), name: z.string(), mimeType: z.string() }),
});
export const fileChunkRpc = defineRpc({
  name: "file.chunk", input: z.object({ ...documentRef, revision, offset: z.number().int().nonnegative(), length: z.number().int().positive() }),
  output: z.object({ revision, offset: z.number().int().nonnegative(), size: z.number().int().nonnegative(), data: z.string(), nextOffset: z.number().int().nonnegative().nullable() }),
});
// The workspace path of a file Paseo opened in a file tab, which names it by its absolute path on the host.
export const docLocateRpc = defineRpc({
  name: "doc.locate",
  input: z.object({ workspaceId: z.string().min(1), absolutePath: z.string().min(1) }),
  output: z.object({ path: z.string().min(1) }),
});

export const docSearchRpc = defineRpc({
  name: "doc.search",
  input: z.object({ ...documentRef, password, query: z.string().trim().min(1).max(200), cursor: searchCursor.nullable().optional(),
    searchId: z.object({ session: z.string().min(1).max(64), generation: z.number().int().nonnegative() }).optional() }),
  output: z.object({ revision, matches: z.array(searchMatch).max(50), next: searchCursor.nullable(), notes: z.array(z.string()), scanned: z.number().int().nonnegative() }),
});
export type DocSearchOutput = RpcOutput<typeof docSearchRpc>;

export const viewerStateReadRpc = defineRpc({
  name: "viewer-state.read", input: z.object(documentRef),
  output: z.object({ saved: z.object({ position: viewerPosition }).nullable(), pins: pagePins, review: reviewMark.nullable() }),
});
export const viewerStateWriteRpc = defineRpc({
  name: "viewer-state.write", input: z.object({ ...documentRef, position: viewerPosition.nullable() }),
  output: z.object({ saved: z.boolean() }),
});
export const viewerStatePinRpc = defineRpc({
  name: "viewer-state.pin",
  input: z.object({ ...documentRef, index: z.number().int().nonnegative(), pin: z.object({ label: pinLabel.optional(), revision: documentRevision }).nullable() }),
  output: z.object({ pins: pagePins }),
});
export const viewerStateReviewRpc = defineRpc({
  name: "viewer-state.review",
  input: z.object({ ...documentRef, revision: documentRevision.nullable() }),
  output: z.object({ review: reviewMark.nullable(), revision: documentRevision }),
});

// The viewer calls this once per open with the revision it showed; `marked` is false when nothing changed.
export const viewerStateOpenedRpc = defineRpc({
  name: "viewer-state.opened",
  input: z.object({ ...documentRef, revision: documentRevision }),
  output: z.object({ marked: z.boolean() }),
});

// The revision each listed file was last opened at; files never opened, or no longer there, are left out.
export const viewerStateOpenedRevisionsRpc = defineRpc({
  name: "viewer-state.opened-revisions",
  input: z.object({ workspaceId: z.string().min(1), paths: z.array(z.string().min(1)).max(OPENED_REVISIONS_MAX_PATHS) }),
  output: z.object({ opened: z.record(z.string(), documentRevision) }),
});

// First-run tips in Documents: one dismissal for every client of the daemon.
export const tipsReadRpc = defineRpc({ name: "tips.read", input: z.object({}), output: z.object({ dismissed: z.boolean() }) });
export const tipsDismissRpc = defineRpc({ name: "tips.dismiss", input: z.object({}), output: z.object({ dismissed: z.literal(true) }) });

// How Documents shows its files, per layout class, shared by every client of the daemon.
export const documentsViewReadRpc = defineRpc({ name: "documents-view.read", input: z.object({}), output: z.object({ views: documentViews }) });
export const documentsViewWriteRpc = defineRpc({
  name: "documents-view.write",
  input: z.object({ layout: z.enum(["compact", "wide"]), view: documentView }),
  output: z.object({ views: documentViews }),
});

export const reviewPageImageRpc = defineRpc({
  name: "review.page-image",
  input: z.object({ ...documentRef, password, revision, index: z.number().int().nonnegative() }),
  output: z.object({ revision, index: z.number().int().nonnegative(), image: encodedImage }),
});
export type ReviewPageImageOutput = RpcOutput<typeof reviewPageImageRpc>;

export const DOCUMENT_RPCS = [docOpenRpc, docPageRpc, docThumbnailRpc, docTextRpc, docRowsRpc, docCellRpc, docIssuesRpc, docBlocksRpc, mediaChunkRpc, docsRecentRpc, docsVisitRpc, docsAnyRpc, fileInfoRpc, fileChunkRpc, docLocateRpc, docSearchRpc, viewerStateReadRpc, viewerStateWriteRpc, viewerStatePinRpc, viewerStateReviewRpc, viewerStateOpenedRpc, viewerStateOpenedRevisionsRpc, tipsReadRpc, tipsDismissRpc, documentsViewReadRpc, documentsViewWriteRpc, reviewPageImageRpc] as const;

export type DocOpenInput = RpcInput<typeof docOpenRpc>;
export type DocOpenOutput = RpcOutput<typeof docOpenRpc>;
export type DocPageInput = RpcInput<typeof docPageRpc>;
export type DocPageOutput = RpcOutput<typeof docPageRpc>;
export type DocThumbnailInput = RpcInput<typeof docThumbnailRpc>;
export type DocThumbnailOutput = RpcOutput<typeof docThumbnailRpc>;
export type DocTextInput = RpcInput<typeof docTextRpc>;
export type DocTextOutput = RpcOutput<typeof docTextRpc>;
export type DocRowsInput = RpcInput<typeof docRowsRpc>;
export type DocRowsOutput = RpcOutput<typeof docRowsRpc>;
export type DocBlocksInput = RpcInput<typeof docBlocksRpc>;
export type DocBlocksOutput = RpcOutput<typeof docBlocksRpc>;
export type MediaChunkInput = RpcInput<typeof mediaChunkRpc>;
export type MediaChunkOutput = RpcOutput<typeof mediaChunkRpc>;
export type DocsRecentInput = RpcInput<typeof docsRecentRpc>;
export type ViewerStateReadOutput = RpcOutput<typeof viewerStateReadRpc>;
export type DocsRecentOutput = RpcOutput<typeof docsRecentRpc>;
export type DocsRecentList = Exclude<DocsRecentOutput, { unchanged: true }>;

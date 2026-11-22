import { z } from "zod";
import { DOCUMENT_KINDS, type DocumentKind } from "./kinds";

// The host accepts contribution ids matching /^[a-z][a-z0-9-]*$/ only; a dotted kind silently
// drops every client contribution of the plugin (packages/app/src/plugins/evaluate.ts).
export const TURN_DOCS_KIND = "turn-docs";
export const TURN_DOCS_MAX_FILES = 12;
// The daemon rejects a timeline row whose serialized data is over 64 KiB.
export const TIMELINE_DATA_MAX_BYTES = 64 * 1024;
// Filesystem timestamp granularity and clock skew between the agent's process and the plugin's.
export const TURN_WINDOW_SLACK_MS = 1_000;

export const turnDocsFileSchema = z.object({
  path: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  size: z.number(),
  revision: z.string(),
  status: z.enum(["new", "changed"]),
});

export const turnDocsGroupSchema = z.object({
  reason: z.enum(["checkout", "folder"]),
  path: z.string(),
  count: z.number(),
  // Only new files fold (groupChanges), so a folder row reads New.
  files: z.array(turnDocsFileSchema.extend({ status: z.literal("new") })),
});

export const turnDocsV1Schema = z.object({
  workspaceId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  files: z.array(turnDocsFileSchema),
  moreCount: z.number(),
  // The workspace scan hit its entry bound, so a changed file may be missing.
  partial: z.boolean(),
});

export const turnDocsSchema = turnDocsV1Schema.extend({ groups: z.array(turnDocsGroupSchema) });

// The row of files that changed while another agent's turn also ran in the workspace (the This session scope).
// Unlike a folder row its files may be changed ones, and it has no folder: `path` is empty. It is always the last row.
export const OTHER_SESSION_REASON = "other-session";
export const turnDocsOtherSessionSchema = z.object({
  reason: z.literal(OTHER_SESSION_REASON),
  path: z.literal(""),
  count: z.number(),
  files: z.array(turnDocsFileSchema),
});

// Version 3: version 2 plus that row. Only cards that contain one are written as version 3.
export const turnDocsV3Schema = turnDocsV1Schema.extend({ groups: z.array(z.union([turnDocsGroupSchema, turnDocsOtherSessionSchema])) });

// A turn of one agent in the workspace, as the plugin saw it: `end` is null while it runs.
export interface TurnWindow {
  start: number;
  end: number | null;
}

// "This session" scope. Every file listed changed inside this turn, and the plugin only sees file times and
// turn windows, so a file changed while another agent's turn also ran cannot be told apart: it goes to its own
// row rather than being dropped, because it may be this agent's. A file changed while no other turn ran stays
// a normal one (this session's, or the user's or a program's, which no scope can tell apart). Both lists keep
// the order they came in, newest first.
export function splitOtherSessions(files: readonly TurnDocsFile[], changedAt: (path: string) => number | undefined, others: readonly TurnWindow[]): { own: TurnDocsFile[]; overlapped: TurnDocsFile[] } {
  const overlaps = (path: string) => {
    const at = changedAt(path);
    return at !== undefined && others.some((turn) => at >= turn.start - TURN_WINDOW_SLACK_MS && (turn.end === null || at <= turn.end + TURN_WINDOW_SLACK_MS));
  };
  return { own: files.filter((file) => !overlaps(file.path)), overlapped: files.filter((file) => overlaps(file.path)) };
}

export type TurnDocsFile = z.infer<typeof turnDocsFileSchema>;
export type TurnDocsGroup = z.infer<typeof turnDocsGroupSchema>;
export type TurnDocsOtherSession = z.infer<typeof turnDocsOtherSessionSchema>;
export type TurnDocsV1 = z.infer<typeof turnDocsV1Schema>;
export type TurnDocs = z.infer<typeof turnDocsSchema>;
export type TurnDocsV3 = z.infer<typeof turnDocsV3Schema>;

// Version 2 adds folder rows. A card without one is written as version 1, which bundles from before
// folder rows render too. Version 3 adds the other-session row and is written only for a card that has one: a
// reader without a version 3 renderer shows the host's "Plugin timeline item unavailable" for that card alone.
export type TurnDocsRow = { type: "plugin"; id: string; kind: string } & ({ version: 1; data: TurnDocsV1 } | { version: 2; data: TurnDocs } | { version: 3; data: TurnDocsV3 });

export const upgradeTurnDocs = (data: TurnDocsV1): TurnDocsV3 => ({ ...data, groups: [] });

export interface ScannedFile {
  path: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  // max(mtime, ctime): a copy or move that keeps the old mtime still counts.
  changedMs: number;
  birthtimeMs?: number;
}

export interface ScannedFolders {
  // Folder birth times, null where the filesystem has none.
  dirs: ReadonlyMap<string, number | null>;
  repos: ReadonlySet<string>;
}

// What existed when the turn started. `complete` is false when the scan hit its bound,
// so a file or folder missing here may still have existed.
export interface Baseline {
  revisions: ReadonlyMap<string, string>;
  dirs: ReadonlySet<string>;
  complete: boolean;
}

export interface ScannedWorkspace extends ScannedFolders {
  entries: readonly ScannedFile[];
  complete: boolean;
}

// The hook reaches the plugin a little after the turn really starts, so the scan can already hold what the
// agent made in that first moment. Files changed and folders born within the slack before startedAt are
// left out and judged by the end scan alone: such a file is new, and such a folder (an early git worktree
// add) is new, which folds its new files. A folder with no trusted birth time stays, as it cannot be placed.
export function baselineAt({ entries, complete, dirs }: ScannedWorkspace, startedAt: number): Baseline {
  const from = startedAt - TURN_WINDOW_SLACK_MS;
  return {
    revisions: new Map(entries.filter((entry) => entry.changedMs < from).map((entry) => [entry.path, entry.revision])),
    dirs: new Set([...dirs].filter(([, born]) => born === null || born < from).map(([dir]) => dir)),
    complete,
  };
}

// Files whose content changed during the turn, newest first. A file that was in the baseline
// with the same revision is skipped, so the slack never reports an untouched file.
export function changedDuringTurn(after: readonly ScannedFile[], baseline: Baseline | null, startedAt: number): TurnDocsFile[] {
  const from = startedAt - TURN_WINDOW_SLACK_MS;
  return after
    .filter((file) => file.changedMs >= from && baseline?.revisions.get(file.path) !== file.revision)
    .sort((a, b) => b.changedMs - a.changedMs || a.path.localeCompare(b.path))
    .map((file) => ({ path: file.path, kind: file.kind, size: file.size, revision: file.revision, status: statusOf(file, baseline, from) }));
}

function statusOf(file: ScannedFile, baseline: Baseline | null, from: number): "new" | "changed" {
  if (baseline?.revisions.has(file.path)) return "changed";
  if (baseline?.complete) return "new";
  // No usable baseline: fall back to birth time, which is 0 or missing on some filesystems.
  return file.birthtimeMs !== undefined && file.birthtimeMs > 0 && file.birthtimeMs >= from ? "new" : "changed";
}

export function groupChanges(
  files: readonly TurnDocsFile[],
  after: ScannedFolders,
  baseline: Baseline | null,
  startedAt: number,
): { files: TurnDocsFile[]; groups: TurnDocsGroup[] } {
  const from = startedAt - TURN_WINDOW_SLACK_MS;
  const memo = new Map<string, "checkout" | "folder" | null>();
  // A complete baseline lists every folder that existed, so one deleted and made again during the turn
  // (rm -rf out, then a build) is not new. Only without one does a birth time inside the turn decide.
  const isNew = (dir: string) => {
    if (baseline?.complete) return !baseline.dirs.has(dir);
    const born = after.dirs.get(dir);
    return born != null && born >= from;
  };
  // A folder that existed stays listed file by file even once it holds a .git (git init).
  const newness = (dir: string) => {
    let known = memo.get(dir);
    if (known === undefined) {
      known = !isNew(dir) ? null : after.repos.has(dir) ? "checkout" : "folder";
      memo.set(dir, known);
    }
    return known;
  };

  const buckets = new Map<string, { reason: "checkout" | "folder"; files: TurnDocsGroup["files"] }>();
  for (const file of files) {
    // A changed file is news even inside a new folder, so it keeps its own row.
    if (!isNewFile(file)) continue;
    const dirs = ancestors(file.path);
    const checkout = dirs.find((dir) => newness(dir) === "checkout");
    const folder = checkout ?? dirs.find((dir) => newness(dir) !== null);
    if (folder === undefined) continue;
    const bucket = buckets.get(folder) ?? { reason: checkout === undefined ? "folder" as const : "checkout" as const, files: [] };
    bucket.files.push(file);
    buckets.set(folder, bucket);
  }
  const groups = [...buckets]
    .filter(([, bucket]) => bucket.reason === "checkout" || bucket.files.length > TURN_DOCS_MAX_FILES)
    .map(([path, bucket]): TurnDocsGroup => ({ reason: bucket.reason, path, count: bucket.files.length, files: bucket.files }));
  const grouped = new Set<TurnDocsFile>(groups.flatMap((group) => group.files));
  return { files: files.filter((file) => !grouped.has(file)), groups };
}

const isNewFile = (file: TurnDocsFile): file is TurnDocsGroup["files"][number] => file.status === "new";

function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// One row per turn; null when nothing changed, so chat-only and canceled no-op turns add no card.
// Files past the cap, or past the daemon's 64 KiB data limit, count into moreCount. Rows go to files first, then
// folder rows, and the other-session row last: it never pushes the turn's own files or folders into "+N more".
// A card made only of overlapped files still shows, as that one row.
export function turnDocsRow(
  input: Omit<TurnDocs, "files" | "groups" | "moreCount"> & { files: readonly TurnDocsFile[]; groups?: readonly TurnDocsGroup[]; overlapped?: readonly TurnDocsFile[]; turnId: string | null },
  { maxFiles = TURN_DOCS_MAX_FILES, maxBytes = TIMELINE_DATA_MAX_BYTES } = {},
): TurnDocsRow | null {
  const { turnId, files, groups = [], overlapped = [], ...rest } = input;
  if (files.length === 0 && groups.length === 0 && overlapped.length === 0) return null;
  const total = files.length + groups.reduce((sum, group) => sum + group.count, 0) + overlapped.length;
  // Files take the rows first: a report must not drop to "+N more" behind a pile of new checkouts.
  const shownFiles = files.slice(0, maxFiles);
  const shownGroups: (TurnDocsGroup | TurnDocsOtherSession)[] = groups.slice(0, maxFiles - shownFiles.length).map((group) => ({ ...group, files: group.files.slice(0, maxFiles) }));
  if (overlapped.length > 0 && shownFiles.length + shownGroups.length < maxFiles) {
    shownGroups.push({ reason: OTHER_SESSION_REASON, path: "", count: overlapped.length, files: overlapped.slice(0, maxFiles) });
  }
  const build = (): TurnDocsV3 => {
    const shown = shownFiles.length + shownGroups.reduce((sum, group) => sum + group.count, 0);
    return { ...rest, files: shownFiles, groups: shownGroups, moreCount: total - shown };
  };
  let data = build();
  while (byteLength(JSON.stringify(data)) > maxBytes) {
    // The other-session row gives up its files first, then the folder rows, so the turn's own files stay longest.
    const other = shownGroups.find((group) => group.reason === OTHER_SESSION_REASON);
    const widest = other && other.files.length > 0 ? other : shownGroups.reduce<TurnDocsGroup | TurnDocsOtherSession | null>((best, group) => (group.files.length > (best?.files.length ?? 0) ? group : best), null);
    if (widest) widest.files = widest.files.slice(0, -1);
    else if (shownFiles.length > 0) shownFiles.pop();
    else if (shownGroups.length > 0) shownGroups.pop();
    else break;
    data = build();
  }
  const id = turnDocsRowId(turnId, input.startedAt);
  if (shownGroups.length === 0) {
    const { groups: _none, ...card } = data;
    return { type: "plugin", id, kind: TURN_DOCS_KIND, version: 1, data: card };
  }
  const folderRows = shownGroups.filter((group): group is TurnDocsGroup => group.reason !== OTHER_SESSION_REASON);
  return folderRows.length === shownGroups.length
    ? { type: "plugin", id, kind: TURN_DOCS_KIND, version: 2, data: { ...data, groups: folderRows } }
    : { type: "plugin", id, kind: TURN_DOCS_KIND, version: 3, data };
}

// Stable per turn: a retried append replaces the row instead of adding a second card. The start time
// keeps ids apart when a provider reuses turn ids, for example after a resume.
export function turnDocsRowId(turnId: string | null, startedAt: number): string {
  return `turn-docs:${turnId ?? "turn"}:${startedAt}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

import { revisionChangedAt } from "../shared/revision";
import type { TurnCardsMode } from "../shared/settings";
import type { TurnDocsFile, TurnDocsGroup, TurnDocsOtherSession, TurnDocsV3 } from "../shared/turn-docs";
import { hasThumbnail, retryBusy } from "./thumbnails";

// "Changed while this turn ran", never "written by this agent": the card comes from file times, so the user or
// a program editing the workspace shows up here too, and so does another agent whose turn ran at the same time
// (in the This session scope those files sit apart, in the other-session row; see TURN_GROUP).
export function turnDocsTitle(data: Pick<TurnDocsV3, "files" | "groups" | "moreCount">): string {
  const total = data.files.length + data.groups.reduce((sum, group) => sum + group.count, 0) + data.moreCount;
  return `${total} ${total === 1 ? "document" : "documents"} changed while this turn ran`;
}

export function turnDocsNote(data: Pick<TurnDocsV3, "outcome" | "partial">): string | null {
  const notes = [
    data.outcome === "canceled" ? "Turn was stopped" : data.outcome === "failed" ? "Turn failed" : null,
    data.partial ? "Large workspace: only part of it was scanned" : null,
  ].filter((note): note is string => note !== null);
  return notes.length > 0 ? notes.join(" · ") : null;
}

// Shown only when the host cannot open the settings screen, so the user still knows where the setting lives.
export const TURN_CARDS_SETTING_HINT = "Change or turn off these cards in Settings, Document viewer.";

export const TURN_CARDS_OPTIONS: readonly { label: string; value: TurnCardsMode }[] = [
  { label: "This session", value: "session" },
  { label: "Anywhere in the workspace", value: "workspace" },
  { label: "Off", value: "off" },
];

export const TURN_CARDS_HINT =
  "A timeline card after each turn lists the documents that changed while it ran. This session lists the ones that changed while no other agent in the same workspace was running, and gathers the rest in one folded row at the bottom, since file times cannot say whose they are. Anywhere in the workspace lists every document that changed, whoever changed it. Off adds no cards and does not scan the workspace for them.";

export const TURN_THUMBNAIL_SIZE = { compact: 36, wide: 40 } as const;
export const TURN_THUMBNAIL_WIDTH = 80;
export const TURN_THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024;
const TURN_THUMBNAIL_RETRIES = 3;
const TURN_THUMBNAIL_RETRY_MS = 4_000;

export const cardThumbnail = (file: Pick<TurnDocsFile, "kind" | "size">) => hasThumbnail(file.kind) && file.size <= TURN_THUMBNAIL_MAX_BYTES;

export const cardThumbnailRetry = retryBusy(TURN_THUMBNAIL_RETRIES, TURN_THUMBNAIL_RETRY_MS);

export type TurnFilePill = "new" | "changed" | "opened";

// Opened at the card's revision, or at one changed strictly later; a tie between two different
// revisions cannot say which came first, so it keeps the turn's verdict.
export function turnFilePill(file: Pick<TurnDocsFile, "status" | "revision">, opened: string | undefined): TurnFilePill {
  if (opened === undefined) return file.status;
  if (opened === file.revision) return "opened";
  const openedAt = revisionChangedAt(opened);
  const changedAt = revisionChangedAt(file.revision);
  return openedAt !== null && changedAt !== null && openedAt > changedAt ? "opened" : file.status;
}

export const TURN_FILE_PILL = {
  new: { status: "new", spoken: "new" },
  changed: { status: "modified", spoken: "changed during this turn" },
  opened: { status: "opened", spoken: "opened since this turn" },
} as const satisfies Record<TurnFilePill, { status: string; spoken: string }>;

export function listedFiles(data: Pick<TurnDocsV3, "files" | "groups">, expanded: ReadonlySet<string>): TurnDocsFile[] {
  return [...data.files, ...data.groups.flatMap((group) => (expanded.has(group.path) ? group.files : []))];
}

const documents = (count: number) => `${count} ${count === 1 ? "document" : "documents"}`;

export const TURN_GROUP = {
  checkout: { detail: (count: number) => `New checkout · ${documents(count)}`, spoken: "new Git checkout" },
  folder: { detail: (count: number) => `New folder · ${documents(count)}`, spoken: "new folder" },
  // Files that changed while another agent's turn also ran: the card cannot say whose they are, so they are
  // folded together at the bottom rather than hidden. `title` stands in for the folder name.
  "other-session": { detail: (count: number) => documents(count), spoken: "may be from another session", title: "May be from another session" },
} as const satisfies Record<(TurnDocsGroup | TurnDocsOtherSession)["reason"], { detail(count: number): string; spoken: string; title?: string }>;

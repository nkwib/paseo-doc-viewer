import { copyFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { revisionOf } from "../server/revision";
import { createTurnDocs, type TurnDocsHost } from "../server/turn-docs";
import { sharedOpenedMarks } from "../client/opened-marks";
import { listedFiles, TURN_GROUP, turnDocsNote, turnDocsTitle, turnFilePill } from "../client/turn-docs";
import { documentRevision } from "../shared/revision";
import { workspace } from "./helpers";
import {
  baselineAt,
  changedDuringTurn,
  groupChanges,
  TIMELINE_DATA_MAX_BYTES,
  TURN_DOCS_KIND,
  TURN_WINDOW_SLACK_MS,
  turnDocsRow,
  turnDocsRowId,
  turnDocsSchema,
  turnDocsV1Schema,
  upgradeTurnDocs,
  type Baseline,
  type ScannedFile,
  type ScannedFolders,
  type TurnDocs,
  type TurnDocsV3,
  type TurnDocsFile,
  type TurnDocsGroup,
  type TurnDocsRow,
} from "../shared/turn-docs";

const T0 = 1_000_000;
const file = (path: string, changedMs: number, revision = `r-${path}-${changedMs}`, extra: Partial<ScannedFile> = {}): ScannedFile => ({
  path,
  kind: path.endsWith(".xlsx") ? "xlsx" : "pdf",
  size: 10,
  revision,
  changedMs,
  ...extra,
});

const NO_FOLDERS = { dirs: new Map<string, number>(), repos: new Set<string>() };
const known = (revisions: [string, string][], complete = true, { dirs = [] as string[] } = {}): Baseline =>
  ({ revisions: new Map(revisions), dirs: new Set(dirs), complete });

describe("changedDuringTurn", () => {
  it("tells new from changed against the baseline and skips untouched files", () => {
    const baseline = known([["report.pdf", "old"], ["same.pdf", "same"]]);
    const after = [
      file("report.pdf", T0 + 500, "new-rev"),
      file("out/data.xlsx", T0 + 900),
      file("same.pdf", T0 + 200, "same"),
      file("older.pdf", T0 - 60_000),
    ];
    expect(changedDuringTurn(after, baseline, T0).map(({ path, status }) => [path, status])).toEqual([
      ["out/data.xlsx", "new"],
      ["report.pdf", "changed"],
    ]);
  });

  it("falls back to birth time when the baseline is incomplete or missing", () => {
    const after = [file("a.pdf", T0 + 10, "x", { birthtimeMs: T0 + 5 }), file("b.pdf", T0 + 10, "y", { birthtimeMs: T0 - 99_000 }), file("c.pdf", T0 + 10, "z", { birthtimeMs: 0 })];
    const statuses = (baseline: Parameters<typeof changedDuringTurn>[1]) => changedDuringTurn(after, baseline, T0).map((entry) => entry.status);
    expect(statuses(known([], false))).toEqual(["new", "changed", "changed"]);
    expect(statuses(null)).toEqual(["new", "changed", "changed"]);
  });

  it("keeps files inside the slack before the start but not older ones", () => {
    const after = [file("edge.pdf", T0 - 500), file("before.pdf", T0 - 1_500)];
    expect(changedDuringTurn(after, known([]), T0).map((entry) => entry.path)).toEqual(["edge.pdf"]);
  });
});

describe("baselineAt", () => {
  it("leaves out files changed and folders born from the slack before the start on, and keeps a folder with no birth time", () => {
    const from = T0 - TURN_WINDOW_SLACK_MS;
    const dirs = new Map<string, number | null>([["old", from - 1], ["early", from], ["unknown", null]]);
    const baseline = baselineAt({ entries: [file("old.pdf", from - 1, "r1"), file("early.pdf", from, "r2")], complete: true, dirs, repos: new Set() }, T0);
    expect([...baseline.revisions]).toEqual([["old.pdf", "r1"]]);
    expect([...baseline.dirs]).toEqual(["old", "unknown"]);
    expect(baseline.complete).toBe(true);
  });
});

describe("groupChanges", () => {
  const changed = (...paths: string[]): TurnDocsFile[] => paths.map((path) => ({ path, kind: "pdf", size: 1, revision: "r", status: "new" }));
  const edited = (...paths: string[]): TurnDocsFile[] => changed(...paths).map((entry) => ({ ...entry, status: "changed" }));
  const many = (dir: string, count: number) => Array.from({ length: count }, (_, index) => `${dir}/page-${index}.pdf`);
  const folders = (dirs: Record<string, number | null>, repos: string[] = []): ScannedFolders => ({ dirs: new Map(Object.entries(dirs)), repos: new Set(repos) });
  const summary = ({ files, groups }: ReturnType<typeof groupChanges>) =>
    ({ files: files.map((entry) => entry.path), groups: groups.map((group) => `${group.reason}:${group.path}:${group.count}`) });
  const born = T0 + 100;
  const old = T0 - 60_000;

  it("folds a new worktree, whose .git is a file, into one row and lists the rest", () => {
    const files = changed("docs/report.pdf", ...many("gallery", 40), "gallery/assets/shot.pdf", "metrics.pdf");
    const after = folders({ docs: old, gallery: born, "gallery/assets": born }, ["", "gallery"]);
    expect(summary(groupChanges(files, after, known([], true, { dirs: ["docs"] }), T0))).toEqual({
      files: ["docs/report.pdf", "metrics.pdf"],
      groups: ["checkout:gallery:41"],
    });
  });

  it("keeps listing new files of nested repos that existed, and never folds the workspace root", () => {
    const files = changed("proj/report.pdf", "proj/out/a.pdf", "root.pdf");
    const after = folders({ proj: 0, "proj/out": born }, ["", "proj"]);
    const result = groupChanges(files, after, known([], true, { dirs: ["proj"] }), T0);
    expect(summary(result)).toEqual({ files: ["proj/report.pdf", "proj/out/a.pdf", "root.pdf"], groups: [] });
  });

  it("folds a new submodule of an existing repo, and a new checkout with its submodules as one row", () => {
    const files = changed("proj/lib/a.pdf", "proj/b.pdf", "clone/c.pdf", "clone/deps/sub/d.pdf");
    const after = folders({ proj: old, "proj/lib": born, clone: born, "clone/deps": born, "clone/deps/sub": born }, ["proj", "proj/lib", "clone", "clone/deps/sub"]);
    const baseline = known([], true, { dirs: ["proj"] });
    expect(summary(groupChanges(files, after, baseline, T0))).toEqual({ files: ["proj/b.pdf"], groups: ["checkout:proj/lib:1", "checkout:clone:2"] });
  });

  it("folds a new folder past 12 changed files, counting its subfolders, and lists one with 12", () => {
    const files = changed(...many("twelve", 12), ...many("thirteen", 6), ...many("thirteen/deep", 7));
    const after = folders({ twelve: born, thirteen: born, "thirteen/deep": born });
    expect(summary(groupChanges(files, after, known([]), T0))).toEqual({ files: many("twelve", 12), groups: ["folder:thirteen:13"] });
  });

  it("with a partial baseline, trusts only birth times, and folds nothing where the birth time is unknown", () => {
    const files = changed("wt/a.pdf", "old/b.pdf", "unknown/c.pdf");
    const after = folders({ wt: born, old, unknown: null }, ["wt", "old", "unknown"]);
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["old/b.pdf", "unknown/c.pdf"], groups: ["checkout:wt:1"] });
    expect(summary(groupChanges(files, after, null, T0))).toEqual({ files: ["old/b.pdf", "unknown/c.pdf"], groups: ["checkout:wt:1"] });
  });

  it("with a complete baseline, folds no folder that existed, even one deleted and made again during the turn", () => {
    const files = changed(...many("out", 13), "again/a.pdf");
    const after = folders({ out: born, again: born }, ["again"]);
    const baseline = known([], true, { dirs: ["out", "again"] });
    expect(summary(groupChanges(files, after, baseline, T0))).toEqual({ files: [...many("out", 13), "again/a.pdf"], groups: [] });
  });

  it("folds a worktree added in the slack before the start, which the baseline scan saw, and not one added earlier", () => {
    const after = folders({ wt: T0 - 500, earlier: T0 - 1_500 }, ["wt", "earlier"]);
    const baseline = baselineAt({ entries: [], complete: true, ...after }, T0);
    expect(summary(groupChanges(changed("wt/a.pdf", "earlier/b.pdf"), after, baseline, T0))).toEqual({ files: ["earlier/b.pdf"], groups: ["checkout:wt:1"] });
  });

  it("lists the files of a repo initialized in a folder that existed", () => {
    const files = changed("init/b.pdf");
    const after = folders({ init: old }, ["init"]);
    expect(summary(groupChanges(files, after, known([], true, { dirs: ["init", "gone"] }), T0))).toEqual({ files: ["init/b.pdf"], groups: [] });
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["init/b.pdf"], groups: [] });
  });

  it("never folds a changed file, even in a new checkout or folder", () => {
    const files = [...changed("wt/a.pdf", ...many("big", 13)), ...edited("wt/moved.pdf", "big/moved.pdf")];
    const after = folders({ wt: born, big: born }, ["wt"]);
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["wt/moved.pdf", "big/moved.pdf"], groups: ["checkout:wt:1", "folder:big:13"] });
  });

  it("adds nothing for a repo the turn deleted", () => {
    const files = changed("kept.pdf");
    const baseline = known([["gone/a.pdf", "r"]], true, { dirs: ["gone"] });
    expect(summary(groupChanges(files, folders({}), baseline, T0))).toEqual({ files: ["kept.pdf"], groups: [] });
  });
});

describe("turnDocsRow", () => {
  const base = { workspaceId: "wks_1", turnId: "turn-7", startedAt: T0, endedAt: T0 + 5_000, outcome: "completed" as const, partial: false };
  const files = (count: number, pathLength = 10): TurnDocsFile[] =>
    Array.from({ length: count }, (_, index) => ({ path: `${String(index).padStart(pathLength, "d")}.pdf`, kind: "pdf", size: 1, revision: "r", status: "new" }));

  it("returns null when nothing changed", () => {
    expect(turnDocsRow({ ...base, files: [] })).toBeNull();
  });

  it("caps at 12 files and counts the rest", () => {
    const row = turnDocsRow({ ...base, files: files(15) })!;
    expect(row.data.files).toHaveLength(12);
    expect(row.data.moreCount).toBe(3);
  });

  it("drops files until the data fits the daemon's 64 KiB limit", () => {
    const row = turnDocsRow({ ...base, files: files(12, 8_000) })!;
    const bytes = new TextEncoder().encode(JSON.stringify(row.data)).length;
    expect(bytes).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    expect(row.data.files.length).toBeLessThan(12);
    expect(row.data.files.length + row.data.moreCount).toBe(12);
  });

  const group = (path: string, count: number, pathLength = 10): TurnDocsGroup =>
    ({ reason: "checkout", path, count, files: files(count, pathLength).map((entry) => ({ ...entry, path: `${path}/${entry.path}`, status: "new" })) });
  // What the client renders: it reads a version 1 row as a card without folder rows.
  const rendered = (row: TurnDocsRow): TurnDocsV3 => (row.version === 1 ? upgradeTurnDocs(row.data) : row.data);

  it("writes a card without folder rows as version 1, which bundles from before folder rows render", () => {
    const row = turnDocsRow({ ...base, files: files(15) })!;
    expect(row.version).toBe(1);
    expect(turnDocsV1Schema.strict().parse(row.data)).toEqual(row.data);
  });

  it("writes a card with a folder row as version 2", () => {
    const row = turnDocsRow({ ...base, files: files(2), groups: [group("gallery", 3)] })!;
    expect(row.version).toBe(2);
    expect(turnDocsSchema.strict().parse(row.data)).toEqual(row.data);
  });

  it("writes version 1 when files fill the 12 rows, so folder rows only count toward the rest", () => {
    const row = turnDocsRow({ ...base, files: files(12), groups: [group("gallery", 65)] })!;
    expect(row.version).toBe(1);
    expect(row.data.moreCount).toBe(65);
    expect(turnDocsTitle(rendered(row))).toBe("77 documents changed while this turn ran");
  });

  it("shows folder rows with the first 12 of their files, and keeps every file in the title count", () => {
    const card = rendered(turnDocsRow({ ...base, files: files(2), groups: [group("gallery", 65)] })!);
    expect(card.files).toHaveLength(2);
    expect(card.groups).toMatchObject([{ path: "gallery", count: 65 }]);
    expect(card.groups[0]!.files).toHaveLength(12);
    expect(card.moreCount).toBe(0);
    expect(turnDocsTitle(card)).toBe("67 documents changed while this turn ran");
    expect(turnDocsRow({ ...base, files: [], groups: [group("gallery", 3)] })!.data.files).toEqual([]);
  });

  it("fills the 12 rows with files first, then folder rows, and counts the rest", () => {
    const card = rendered(turnDocsRow({ ...base, files: files(10), groups: [group("a", 20), group("b", 13), group("c", 1)] })!);
    expect(card.files).toHaveLength(10);
    expect(card.groups.map((entry) => entry.path)).toEqual(["a", "b"]);
    expect(card.moreCount).toBe(1);
    expect(turnDocsTitle(card)).toBe("44 documents changed while this turn ran");
  });

  it("lists a report even when 12 new checkouts came with it", () => {
    const report = { ...files(1)[0]!, path: "REPORT.pdf" };
    const checkouts = Array.from({ length: 12 }, (_, index) => group(`wt-${index}`, 3));
    const card = rendered(turnDocsRow({ ...base, files: [report], groups: checkouts })!);
    expect(card.files.map((entry) => entry.path)).toEqual(["REPORT.pdf"]);
    expect(card.groups.map((entry) => entry.path)).toEqual(checkouts.slice(0, 11).map((entry) => entry.path));
    expect(card.moreCount).toBe(3);
    expect(turnDocsTitle(card)).toBe("37 documents changed while this turn ran");
  });

  it("past 64 KiB drops a folder row's expanded files before listed files", () => {
    const row = turnDocsRow({ ...base, files: files(3, 3_000), groups: [group("a", 30, 3_000), group("b", 30, 3_000)] })!;
    expect(new TextEncoder().encode(JSON.stringify(row.data)).length).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    const card = rendered(row);
    expect(card.files).toHaveLength(3);
    expect(card.groups.map((entry) => entry.count)).toEqual([30, 30]);
    expect(card.groups[0]!.files.length + card.groups[1]!.files.length).toBeLessThan(24);
    expect(Math.abs(card.groups[0]!.files.length - card.groups[1]!.files.length)).toBeLessThanOrEqual(1);
    expect(turnDocsTitle(card)).toBe("63 documents changed while this turn ran");
  });

  it("keeps rows stored as version 1 readable", () => {
    const stored = { workspaceId: "wks_1", startedAt: T0, endedAt: T0 + 1, outcome: "completed", files: files(1), moreCount: 0, partial: false };
    expect(turnDocsSchema.safeParse(stored).success).toBe(false);
    expect(upgradeTurnDocs(turnDocsV1Schema.parse(stored))).toEqual({ ...stored, groups: [] });
  });

  it("has a stable id per turn and a kind the host accepts", () => {
    const row = turnDocsRow({ ...base, files: files(1) })!;
    expect(row).toMatchObject({ type: "plugin", id: `turn-docs:turn-7:${T0}`, kind: TURN_DOCS_KIND, version: 1 });
    expect(TURN_DOCS_KIND).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(turnDocsRowId(null, T0)).toBe(`turn-docs:turn:${T0}`);
  });
});

describe("card labels", () => {
  it("says changed while the turn ran, not written by the agent", () => {
    expect(turnDocsTitle({ files: [{} as TurnDocsFile], groups: [], moreCount: 0 })).toBe("1 document changed while this turn ran");
    expect(turnDocsTitle({ files: [{} as TurnDocsFile, {} as TurnDocsFile], groups: [], moreCount: 3 })).toBe("5 documents changed while this turn ran");
    expect(turnDocsTitle({ files: [{} as TurnDocsFile], groups: [{ reason: "checkout", path: "wt", count: 65, files: [] }], moreCount: 1 }))
      .toBe("67 documents changed while this turn ran");
    expect(turnDocsNote({ outcome: "completed", partial: false })).toBeNull();
    expect(turnDocsNote({ outcome: "canceled", partial: true })).toBe("Turn was stopped · Large workspace: only part of it was scanned");
  });
});

describe("card folder rows", () => {
  const entry = (path: string) => ({ path, kind: "pdf" as const, size: 1, revision: "r", status: "new" as const });
  const data = {
    files: [entry("a.pdf")],
    groups: [
      { reason: "checkout" as const, path: "wt", count: 65, files: [entry("wt/b.pdf"), entry("wt/c.pdf")] },
      { reason: "folder" as const, path: "out", count: 13, files: [entry("out/d.pdf")] },
    ],
  };

  it("lists, and so steps through, a folder row's files only once it is shown", () => {
    expect(listedFiles(data, new Set()).map((file) => file.path)).toEqual(["a.pdf"]);
    expect(listedFiles(data, new Set(["out"])).map((file) => file.path)).toEqual(["a.pdf", "out/d.pdf"]);
    expect(listedFiles(data, new Set(["out", "wt"])).map((file) => file.path)).toEqual(["a.pdf", "wt/b.pdf", "wt/c.pdf", "out/d.pdf"]);
  });

  it("says what the row stands for", () => {
    expect(TURN_GROUP.checkout.detail(65)).toBe("New checkout · 65 documents");
    expect(TURN_GROUP.checkout.detail(1)).toBe("New checkout · 1 document");
    expect(TURN_GROUP.folder.detail(13)).toBe("New folder · 13 documents");
  });

  it("can hold only new files, so the row's New pill is right", () => {
    const card = { workspaceId: "w", startedAt: T0, endedAt: T0 + 1, outcome: "completed", partial: false, moreCount: 0, files: [] };
    const group = (status: string) => ({ reason: "folder", path: "out", count: 1, files: [{ ...entry("out/a.pdf"), status }] });
    expect(turnDocsSchema.safeParse({ ...card, groups: [group("new")] }).success).toBe(true);
    expect(turnDocsSchema.safeParse({ ...card, groups: [group("changed")] }).success).toBe(false);
  });
});

describe("card row pill", () => {
  const atTurn = documentRevision(100, T0, T0);
  const row = (status: "new" | "changed") => ({ status, revision: atTurn });

  it("keeps the turn's verdict until the file is opened at the card's revision or a later one", () => {
    expect(turnFilePill(row("new"), undefined)).toBe("new");
    expect(turnFilePill(row("changed"), undefined)).toBe("changed");
    expect(turnFilePill(row("new"), atTurn)).toBe("opened");
    expect(turnFilePill(row("changed"), documentRevision(120, T0 + 5_000, T0 + 5_000))).toBe("opened");
    expect(turnFilePill(row("new"), documentRevision(90, T0 - 5_000, T0 - 5_000))).toBe("new");
    expect(turnFilePill(row("changed"), "not a revision")).toBe("changed");
  });

  it("compares change times like the card does, so a copy keeping an old mtime is not taken as opened", () => {
    const openedBefore = documentRevision(90, T0 - 5_000, T0 - 5_000);
    const copiedOver = { status: "changed" as const, revision: documentRevision(100, T0 - 60_000, T0 + 10_000) };
    expect(turnFilePill(copiedOver, openedBefore)).toBe("changed");
    const openedCopyLater = documentRevision(100, T0 - 90_000, T0 + 20_000);
    expect(turnFilePill(row("new"), openedCopyLater)).toBe("opened");
    expect(turnFilePill(row("new"), documentRevision(100, T0 + 20_000, T0 - 90_000))).toBe("opened");
  });

  it("keeps the turn's verdict when two different revisions changed at the same time", () => {
    expect(turnFilePill(row("changed"), documentRevision(120, T0, T0))).toBe("changed");
    expect(turnFilePill({ status: "changed", revision: documentRevision(100, T0, T0 + 10) }, documentRevision(100, T0, T0))).toBe("changed");
    expect(turnFilePill(row("new"), documentRevision(100, T0, T0 + 1))).toBe("opened");
  });

  it("matches a real cp -p: the card says Changed and the row does not say Opened", () => {
    const root = workspace({ "report.pdf": "opened version", "backup.pdf": "older copy" });
    const report = join(root, "report.pdf");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "backup.pdf"), past, past);
    const opened = revisionOf(statSync(report));
    const startedAt = Date.now();
    const baseline = known([["report.pdf", opened]]);
    copyFileSync(join(root, "backup.pdf"), report);
    utimesSync(report, past, past);
    const info = statSync(report);
    const after = { path: "report.pdf", kind: "pdf" as const, size: info.size, revision: revisionOf(info), changedMs: Math.max(info.mtimeMs, info.ctimeMs) };
    const [listed] = changedDuringTurn([after], baseline, startedAt);
    expect(listed).toMatchObject({ path: "report.pdf", status: "changed" });
    expect(turnFilePill(listed!, opened)).toBe("changed");
  });

  it("hears marks through one emitter per global object, and stops after unsubscribing", () => {
    const global = {};
    const marks = sharedOpenedMarks(global);
    expect(sharedOpenedMarks(global)).toBe(marks);
    expect(sharedOpenedMarks({})).not.toBe(marks);
    const heard: string[] = [];
    const stop = marks.subscribe((event) => heard.push(`${event.workspaceId}:${event.path}`));
    marks.notify({ workspaceId: "w", path: "a.pdf" });
    stop();
    marks.notify({ workspaceId: "w", path: "b.pdf" });
    expect(heard).toEqual(["w:a.pdf"]);
  });
});

describe("createTurnDocs", () => {
  const agent = { id: "agent-1", workspaceId: "wks_1", parentAgentId: null, provider: "fake", cwd: "/ws", title: null };

  function harness({ before, after, enabled = true }: { before: ScannedFile[]; after: ScannedFile[]; enabled?: boolean }) {
    let clock = T0;
    // The start scan is the one that says how recent it must be (notBefore); the end scan never does.
    const scans: (number | undefined)[] = [];
    const appended: unknown[] = [];
    const service = createTurnDocs({
      scan: async (_root, notBefore) => {
        scans.push(notBefore);
        return { entries: notBefore === undefined ? after : before, complete: true, ...NO_FOLDERS };
      },
      enabled: async () => enabled,
      now: () => clock,
      log: () => {},
    });
    const host: TurnDocsHost = { resolveRoot: async () => "/ws", append: async (_id, row) => appended.push(row) };
    return {
      appended,
      scans,
      async turn(outcome: "completed" | "canceled" = "completed") {
        service.turnStarted({ agent, turnId: "t1" }, host);
        clock += 4_000;
        const kind = outcome === "completed" ? { kind: "completed" as const } : { kind: "canceled" as const, reason: "user" };
        return service.turnEnded({ agent, turnId: "t1", outcome: kind, timeline: [] }, host);
      },
    };
  }

  it("appends one row listing new and changed documents", async () => {
    const h = harness({ before: [file("report.pdf", T0 - 60_000, "v1")], after: [file("report.pdf", T0 + 2_000, "v2"), file("data.xlsx", T0 + 3_000)] });
    const row = await h.turn();
    expect(h.appended).toEqual([row]);
    expect(row!.data.files.map(({ path, status }) => [path, status])).toEqual([["data.xlsx", "new"], ["report.pdf", "changed"]]);
  });

  it("adds no row for a chat-only turn, or a canceled turn that changed nothing", async () => {
    const same = [file("report.pdf", T0 - 60_000, "v1")];
    const h = harness({ before: same, after: same });
    expect(await h.turn()).toBeNull();
    expect(await h.turn("canceled")).toBeNull();
    expect(h.appended).toEqual([]);
  });

  it("asks for a start scan that began no earlier than the slack before the start, and an end scan that is always new", async () => {
    const h = harness({ before: [], after: [file("a.pdf", T0 + 1_000)] });
    await h.turn();
    expect(h.scans).toHaveLength(2);
    expect(h.scans).toContain(T0 - TURN_WINDOW_SLACK_MS);
    expect(h.scans).toContain(undefined);
  });

  it("still reports a canceled turn that changed files", async () => {
    const h = harness({ before: [], after: [file("a.pdf", T0 + 1_000)] });
    expect((await h.turn("canceled"))!.data.outcome).toBe("canceled");
  });

  it("respects the setting, without scanning the workspace at the start or the end, and needs a recorded start", async () => {
    const h = harness({ before: [], after: [file("a.pdf", T0 + 1_000)], enabled: false });
    expect(await h.turn()).toBeNull();
    expect(h.scans).toEqual([]);
    const service = createTurnDocs({ scan: async () => ({ entries: [file("a.pdf", T0 + 1)], complete: true, ...NO_FOLDERS }), enabled: async () => true, log: () => {} });
    expect(await service.turnEnded({ agent, turnId: "x", outcome: { kind: "completed" }, timeline: [] }, { resolveRoot: async () => "/ws", append: async () => {} })).toBeNull();
  });
});

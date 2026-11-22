import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTurnDocs, TURN_WINDOWS_MAX, type TurnDocsHost } from "../server/turn-docs";
import { listedFiles, TURN_CARDS_OPTIONS, TURN_GROUP, turnDocsTitle } from "../client/turn-docs";
import { turnCardsMode, viewerSettings, withTurnCardsMode } from "../shared/settings";
import { splitOtherSessions, TIMELINE_DATA_MAX_BYTES, TURN_DOCS_MAX_FILES, TURN_WINDOW_SLACK_MS, turnDocsRow, turnDocsSchema, turnDocsV1Schema, turnDocsV3Schema, upgradeTurnDocs, type ScannedFile, type TurnDocsFile, type TurnDocsGroup, type TurnDocsRow, type TurnDocsV3 } from "../shared/turn-docs";

const T0 = 1_000_000;
const file = (path: string, changedMs: number): ScannedFile => ({ path, kind: "pdf", size: 10, revision: `r-${path}-${changedMs}`, changedMs });
const listed = (path: string, status: "new" | "changed" = "new"): TurnDocsFile => ({ path, kind: "pdf", size: 10, revision: `r-${path}`, status });
const NO_FOLDERS = { dirs: new Map<string, number>(), repos: new Set<string>() };

describe("splitOtherSessions", () => {
  const at = (times: Record<string, number>) => (path: string) => times[path];
  const paths = (files: TurnDocsFile[]) => files.map((entry) => entry.path);

  it("keeps a file changed while no other turn ran, and sets apart one that overlapped another turn", () => {
    const files = [listed("overlap.pdf"), listed("alone.pdf")];
    const split = splitOtherSessions(files, at({ "overlap.pdf": T0 + 500, "alone.pdf": T0 + 9_000 }), [{ start: T0, end: T0 + 1_000 }]);
    expect([paths(split.own), paths(split.overlapped)]).toEqual([["alone.pdf"], ["overlap.pdf"]]);
  });

  it("counts a turn still running, and the slack on both ends of a window", () => {
    const window = { start: T0 + 10_000, end: T0 + 20_000 };
    const times = { before: window.start - TURN_WINDOW_SLACK_MS, tooEarly: window.start - TURN_WINDOW_SLACK_MS - 1, after: window.end + TURN_WINDOW_SLACK_MS, tooLate: window.end + TURN_WINDOW_SLACK_MS + 1 };
    const split = splitOtherSessions(Object.keys(times).map((name) => listed(name)), at(times), [window]);
    expect(paths(split.overlapped).sort()).toEqual(["after", "before"]);
    expect(paths(splitOtherSessions([listed("x")], at({ x: T0 + 99_999_999 }), [{ start: T0, end: null }]).overlapped)).toEqual(["x"]);
  });

  it("sets nothing apart without other turns, keeps the order within each list, and never drops a file", () => {
    const files = [listed("b"), listed("a"), listed("d"), listed("c")];
    expect(splitOtherSessions(files, at({}), [])).toEqual({ own: files, overlapped: [] });
    const split = splitOtherSessions(files, at({ b: 5_000, a: 1, d: 5_000, c: 2 }), [{ start: 4_000, end: 6_000 }]);
    expect([paths(split.own), paths(split.overlapped)]).toEqual([["a", "c"], ["b", "d"]]);
    const many = Array.from({ length: 30 }, (_, index) => listed(`f${index}.pdf`));
    const all = splitOtherSessions(many, at(Object.fromEntries(many.map((entry) => [entry.path, T0]))), [{ start: T0, end: null }]);
    expect(all.own.length + all.overlapped.length).toBe(30);
  });

  it("leaves a file with no known time with the turn's own", () => {
    expect(paths(splitOtherSessions([listed("unknown.pdf")], at({}), [{ start: T0, end: null }]).own)).toEqual(["unknown.pdf"]);
  });
});

describe("the other-session row in turnDocsRow", () => {
  const base = { workspaceId: "w", turnId: "t", startedAt: T0, endedAt: T0 + 5_000, outcome: "completed" as const, partial: false };
  const many = (prefix: string, count: number, status: "new" | "changed" = "changed"): TurnDocsFile[] => Array.from({ length: count }, (_, index) => listed(`${prefix}${index}.pdf`, status));
  const checkout = (path: string, count: number): TurnDocsGroup => ({ reason: "checkout", path, count, files: many(`${path}/f`, count, "new") as TurnDocsGroup["files"] });
  const dataOf = (row: TurnDocsRow): TurnDocsV3 => (row.version === 1 ? upgradeTurnDocs(row.data) : row.data);
  const other = (row: TurnDocsRow) => dataOf(row).groups.find((group) => group.reason === "other-session");

  it("is written only with version 3 and only on a card that has one, and a version 2 reader cannot decode it", () => {
    expect(turnDocsRow({ ...base, files: many("a", 2) })!.version).toBe(1);
    expect(turnDocsRow({ ...base, files: many("a", 2), groups: [checkout("wt", 3)] })!.version).toBe(2);
    const row = turnDocsRow({ ...base, files: many("a", 2), groups: [checkout("wt", 3)], overlapped: many("s", 5) })!;
    expect(row.version).toBe(3);
    expect(turnDocsV3Schema.safeParse(dataOf(row)).success).toBe(true);
    // Version 2 and 1 renderers never see a version 3 card: the host picks the renderer by exact version, and
    // the v2 schema would refuse the new reason anyway.
    expect(turnDocsSchema.safeParse(dataOf(row)).success).toBe(false);
    expect(dataOf(row).groups.map((group) => group.reason)).toEqual(["checkout", "other-session"]);
  });

  it("holds the overlapped files, new or changed, with their count, as the last row", () => {
    const row = turnDocsRow({ ...base, files: many("a", 2), overlapped: [listed("n.pdf", "new"), listed("c.pdf", "changed")] })!;
    expect(dataOf(row).files.map((entry) => entry.path)).toEqual(["a0.pdf", "a1.pdf"]);
    expect(other(row)).toEqual({ reason: "other-session", path: "", count: 2, files: [listed("n.pdf", "new"), listed("c.pdf", "changed")] });
    expect(dataOf(row).moreCount).toBe(0);
  });

  it("keeps a card made only of overlapped files, as that one collapsed row", () => {
    const row = turnDocsRow({ ...base, files: [], overlapped: many("s", 12) })!;
    expect(dataOf(row).files).toEqual([]);
    expect(dataOf(row).groups).toHaveLength(1);
    expect(other(row)!.count).toBe(12);
    expect(turnDocsTitle(dataOf(row))).toBe("12 documents changed while this turn ran");
    expect(turnDocsRow({ ...base, files: [], overlapped: [] })).toBeNull();
  });

  it("takes a row last: own files and folder rows are never pushed into +N more, and it counts into +N more when no row is left", () => {
    const roomy = turnDocsRow({ ...base, files: many("a", 3), groups: [checkout("wt", 40)], overlapped: many("s", 30) })!;
    expect(dataOf(roomy).files).toHaveLength(3);
    expect(dataOf(roomy).groups.map((group) => [group.reason, group.count])).toEqual([["checkout", 40], ["other-session", 30]]);
    expect(dataOf(roomy).moreCount).toBe(0);
    expect(other(roomy)!.files).toHaveLength(TURN_DOCS_MAX_FILES);
    const full = turnDocsRow({ ...base, files: many("a", 12), overlapped: many("s", 4) })!;
    expect(full.version).toBe(1);
    expect(dataOf(full).files).toHaveLength(12);
    expect(dataOf(full).moreCount).toBe(4);
    const foldersFull = turnDocsRow({ ...base, files: many("a", 3), groups: Array.from({ length: 9 }, (_, index) => checkout(`wt${index}`, 2)), overlapped: many("s", 4) })!;
    expect(dataOf(foldersFull).groups.map((group) => group.reason)).toEqual(Array(9).fill("checkout"));
    expect(dataOf(foldersFull).moreCount).toBe(4);
  });

  it("gives up its own files first when the data passes 64 KiB, before any of the turn's files", () => {
    const long = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => listed(`${prefix}${"d".repeat(3_000)}${index}.pdf`));
    const row = turnDocsRow({ ...base, files: long("own", 6), overlapped: long("s", 12) })!;
    expect(new TextEncoder().encode(JSON.stringify(dataOf(row))).length).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    expect(dataOf(row).files).toHaveLength(6);
    expect(other(row)!.count).toBe(12);
    expect(other(row)!.files.length).toBeLessThan(12);
    expect(dataOf(row).moreCount).toBe(0);
    const tight = turnDocsRow({ ...base, files: long("own", 12), overlapped: long("s", 12) })!;
    expect(new TextEncoder().encode(JSON.stringify(dataOf(tight))).length).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    expect(dataOf(tight).files.length).toBeGreaterThan(0);
  });

  it("names itself for the card, and its files join Previous and Next only once shown", () => {
    const row = turnDocsRow({ ...base, files: many("a", 1), overlapped: many("s", 3) })!;
    expect(TURN_GROUP["other-session"].title).toBe("May be from another session");
    expect(TURN_GROUP["other-session"].detail(3)).toBe("3 documents");
    expect(TURN_GROUP["other-session"].spoken).toBe("may be from another session");
    expect(listedFiles(dataOf(row), new Set()).map((entry) => entry.path)).toEqual(["a0.pdf"]);
    expect(listedFiles(dataOf(row), new Set([""])).map((entry) => entry.path)).toEqual(["a0.pdf", "s0.pdf", "s1.pdf", "s2.pdf"]);
    expect(turnDocsTitle(dataOf(row))).toBe("4 documents changed while this turn ran");
  });

  it("is not part of a version 1 card: a card without one still parses as before", () => {
    const row = turnDocsRow({ ...base, files: many("a", 1) })!;
    expect(turnDocsV1Schema.safeParse(row.data).success).toBe(true);
  });
});

describe("Changed documents setting", () => {
  it("reads unset scope as This session, and stored fields as the three options", () => {
    expect(turnCardsMode({ turnCards: true })).toBe("session");
    expect(turnCardsMode({ turnCards: true, turnCardsScope: "session" })).toBe("session");
    expect(turnCardsMode({ turnCards: true, turnCardsScope: "workspace" })).toBe("workspace");
    expect(turnCardsMode({ turnCards: false })).toBe("off");
    expect(turnCardsMode({ turnCards: false, turnCardsScope: "workspace" })).toBe("off");
    expect(TURN_CARDS_OPTIONS.map((option) => option.label)).toEqual(["This session", "Anywhere in the workspace", "Off"]);
  });

  it("writes each option to the two fields, keeping turnCards a plain on/off for older clients", () => {
    const stored = { turnCards: true, kindColors: true, turnCardsScope: "workspace" as const };
    expect(withTurnCardsMode(stored, "session")).toEqual({ turnCards: true, kindColors: true, turnCardsScope: "session" });
    expect(withTurnCardsMode({ turnCards: true, kindColors: true }, "workspace")).toEqual({ turnCards: true, kindColors: true, turnCardsScope: "workspace" });
    expect(withTurnCardsMode(stored, "off")).toEqual({ turnCards: false, kindColors: true, turnCardsScope: "workspace" });
    expect(withTurnCardsMode({ turnCards: false, kindColors: true }, "session").turnCards).toBe(true);
  });

  it("parses settings saved before the scope existed, and rejects an unknown scope", () => {
    expect(viewerSettings.schema.parse({ turnCards: false, kindColors: true })).toEqual({ turnCards: false, kindColors: true });
    expect(viewerSettings.schema.parse({ turnCards: true, turnCardsScope: "workspace" }).turnCardsScope).toBe("workspace");
    expect(viewerSettings.schema.safeParse({ turnCardsScope: "everything" }).success).toBe(false);
    const before = z.object({ turnCards: z.boolean().default(true), kindColors: z.boolean().default(true) });
    expect(before.parse({ turnCards: true, turnCardsScope: "workspace" })).toEqual({ turnCards: true, kindColors: true });
  });
});

describe("createTurnDocs in a shared workspace", () => {
  const agent = (id: string, workspaceId = "wks_1") => ({ id, workspaceId, parentAgentId: null, provider: "fake", cwd: "/ws", title: null });
  const A = agent("agent-a");
  const B = agent("agent-b");

  function harness(entries: ScannedFile[], { scope, enabled = true, folders = NO_FOLDERS }: { scope?: () => Promise<"session" | "workspace">; enabled?: boolean; folders?: { dirs: Map<string, number>; repos: Set<string> } } = {}) {
    let clock = T0;
    let scans = 0;
    const service = createTurnDocs({
      // Files exist from their change time on, like a real disk.
      scan: async () => ({ entries: (scans++, entries.filter((entry) => entry.changedMs <= clock)), complete: true, ...folders }),
      enabled: async () => enabled,
      scope: scope ?? (async () => "session"),
      now: () => clock,
      log: () => {},
    });
    const appended: unknown[] = [];
    const host: TurnDocsHost = { resolveRoot: async () => "/ws", append: async (_id, row) => appended.push(row) };
    return {
      service,
      appended,
      scans: () => scans,
      at(ms: number) {
        clock = ms;
      },
      start: (who: typeof A) => service.turnStarted({ agent: who, turnId: "t" }, host),
      end: (who: typeof A) => service.turnEnded({ agent: who, turnId: `end-${who.id}`, outcome: { kind: "completed" }, timeline: [] }, host),
    };
  }
  const kept = (row: TurnDocsRow | null) => row!.data.files.map((entry) => entry.path);
  const groupsOf = (row: TurnDocsRow | null) => (row && row.version !== 1 ? row.data.groups : []);
  const apart = (row: TurnDocsRow | null) => groupsOf(row).flatMap((group) => (group.reason === "other-session" ? group.files.map((entry) => entry.path) : []));

  // A runs T0..T0+20 s; B runs T0+5 s..T0+10 s inside it.
  const entries = [file("alone-before.pdf", T0 + 2_000), file("both.pdf", T0 + 7_000), file("alone-after.pdf", T0 + 15_000)];

  async function overlapping(h: ReturnType<typeof harness>) {
    h.start(A);
    h.at(T0 + 5_000);
    h.start(B);
    h.at(T0 + 10_000);
    const rowB = await h.end(B);
    h.at(T0 + 20_000);
    const rowA = await h.end(A);
    return { rowA, rowB };
  }

  it("keeps what changed while the agent ran alone as normal rows, and sets what overlapped another turn apart in one row", async () => {
    const { rowA, rowB } = await overlapping(harness(entries));
    expect([kept(rowA), apart(rowA), rowA!.version]).toEqual([["alone-after.pdf", "alone-before.pdf"], ["both.pdf"], 3]);
    // B ran while A still did, so its only file is from that stretch: the card stays, as just the one row.
    expect([kept(rowB), apart(rowB), rowB!.version]).toEqual([[], ["both.pdf"], 3]);
    expect(rowB!.data.moreCount).toBe(0);
  });

  it("in the Anywhere scope, or with no scope given as before the option, lists everything as normal rows, as a version 1 card", async () => {
    let clock = T0;
    const legacy = createTurnDocs({ scan: async () => ({ entries: [file("a.pdf", T0 + 2_000)], complete: true, ...NO_FOLDERS }), enabled: async () => true, now: () => clock, log: () => {} });
    const host: TurnDocsHost = { resolveRoot: async () => "/ws", append: async () => {} };
    legacy.turnStarted({ agent: A, turnId: "t" }, host);
    legacy.turnStarted({ agent: B, turnId: "t" }, host);
    clock += 4_000;
    expect(kept(await legacy.turnEnded({ agent: A, turnId: "a", outcome: { kind: "completed" }, timeline: [] }, host))).toEqual(["a.pdf"]);
    const { rowA, rowB } = await overlapping(harness(entries, { scope: async () => "workspace" }));
    expect([kept(rowA), apart(rowA), rowA!.version]).toEqual([["alone-after.pdf", "both.pdf", "alone-before.pdf"], [], 1]);
    expect([kept(rowB), apart(rowB), rowB!.version]).toEqual([["both.pdf"], [], 1]);
  });

  it("does not count an agent in another workspace, the agent's own earlier turn, or a turn long over", async () => {
    const h = harness([file("x.pdf", T0 + 40_000)]);
    h.start(agent("other", "wks_2"));
    h.at(T0 + 30_000);
    h.start(A);
    h.at(T0 + 35_000);
    await h.end(A);
    h.at(T0 + 36_000);
    h.start(B);
    h.at(T0 + 38_000);
    await h.end(B);
    h.start(A);
    h.at(T0 + 50_000);
    const row = await h.end(A);
    expect([kept(row), apart(row), row!.version]).toEqual([["x.pdf"], [], 1]);
  });

  it("sets a file apart when another turn was still running as this card was built", async () => {
    const h = harness([file("late.pdf", T0 + 8_000)]);
    h.start(A);
    h.at(T0 + 5_000);
    h.start(B);
    h.at(T0 + 10_000);
    const row = await h.end(A);
    expect([kept(row), apart(row)]).toEqual([[], ["late.pdf"]]);
  });

  it("makes no card and no scan while Off, whatever the scope", async () => {
    const h = harness(entries, { enabled: false, scope: async () => "session" });
    const { rowA, rowB } = await overlapping(h);
    expect([rowA, rowB, h.scans()]).toEqual([null, null, 0]);
  });

  describe("files of a new checkout or folder that overlapped another turn", () => {
    // The other-session row takes them, so the uncertain files stay in one place; the turn's own files fold as usual.
    const checkoutFolders = { dirs: new Map([["wt", T0 + 3_000]]), repos: new Set(["wt"]) };

    it("go to the other-session row, and the checkout row folds only the turn's own files", async () => {
      const h = harness([file("wt/own.pdf", T0 + 3_500), file("wt/shared.pdf", T0 + 7_000)], { folders: checkoutFolders });
      const { rowA } = await overlapping(h);
      expect(groupsOf(rowA).map((group) => [group.reason, group.path, group.files.map((entry) => entry.path)])).toEqual([["checkout", "wt", ["wt/own.pdf"]], ["other-session", "", ["wt/shared.pdf"]]]);
      expect(kept(rowA)).toEqual([]);
    });

    it("do not count toward folding a new folder: 13 overlapped and one of the turn's own list the own one as a normal row", async () => {
      const many = Array.from({ length: 13 }, (_, index) => file(`out/s${index}.pdf`, T0 + 7_000 + index));
      const h = harness([file("out/own.pdf", T0 + 3_500), ...many], { folders: { dirs: new Map([["out", T0 + 3_000]]), repos: new Set() } });
      const { rowA } = await overlapping(h);
      expect(kept(rowA)).toEqual(["out/own.pdf"]);
      expect(groupsOf(rowA).map((group) => [group.reason, group.count])).toEqual([["other-session", 13]]);
    });

    it("leave a card with only the other-session row when the checkout is all overlapped", async () => {
      const h = harness([file("wt/a.pdf", T0 + 7_000), file("wt/b.pdf", T0 + 7_100)], { folders: checkoutFolders });
      const { rowA } = await overlapping(h);
      expect(groupsOf(rowA).map((group) => [group.reason, group.count])).toEqual([["other-session", 2]]);
    });
  });

  describe("turn windows", () => {
    it("are dropped once no running turn could overlap them, and kept while one could", async () => {
      const h = harness([]);
      h.start(A);
      h.at(T0 + 5_000);
      h.start(B);
      h.at(T0 + 10_000);
      await h.end(B);
      expect(h.service.windowCount("wks_1")).toBe(2);
      h.at(T0 + 20_000);
      await h.end(A);
      expect(h.service.windowCount("wks_1")).toBe(0);
    });

    it("keep a turn that ended before the running one began only within the slack", async () => {
      const h = harness([]);
      h.start(B);
      h.at(T0 + 1_000);
      await h.end(B);
      h.at(T0 + 1_000 + 2 * TURN_WINDOW_SLACK_MS + 1);
      h.start(A);
      expect(h.service.windowCount("wks_1")).toBe(1);
      h.at(T0 + 100_000);
      await h.end(A);
      expect(h.service.windowCount("wks_1")).toBe(0);
    });

    it("stay bounded beside a turn that never ends, and go when that agent is forgotten", async () => {
      const h = harness([]);
      h.start(A);
      for (let index = 0; index < TURN_WINDOWS_MAX * 2; index++) {
        h.at(T0 + 10_000 + index * 10);
        h.start(B);
        await h.end(B);
      }
      expect(h.service.windowCount("wks_1")).toBeLessThanOrEqual(TURN_WINDOWS_MAX);
      expect(h.service.windowCount("wks_1")).toBeGreaterThan(1);
      h.service.forget(A.id);
      expect(h.service.windowCount("wks_1")).toBe(0);
    });

    it("close a turn whose end never came when the agent starts another, and on forget", async () => {
      const h = harness([file("f.pdf", T0 + 12_000)]);
      h.start(B);
      h.at(T0 + 5_000);
      h.start(B);
      h.at(T0 + 10_000);
      h.start(A);
      h.at(T0 + 20_000);
      // B's first turn was closed at T0+5 s, and its second is still running: f.pdf overlaps the second.
      expect(apart(await h.end(A))).toEqual(["f.pdf"]);
      h.service.forget(B.id);
      expect(h.service.windowCount("wks_1")).toBe(0);
    });
  });
});

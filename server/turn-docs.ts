import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { baselineAt, changedDuringTurn, groupChanges, splitOtherSessions, TURN_WINDOW_SLACK_MS, turnDocsRow, type Baseline, type ScannedFile, type ScannedWorkspace, type TurnDocsRow, type TurnWindow } from "../shared/turn-docs";

type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

// The daemon side of a hook call; the hook context carries the Paseo API.
export interface TurnDocsHost {
  resolveRoot(workspaceId: string): Promise<string>;
  append(agentId: string, row: TurnDocsRow): Promise<unknown>;
}

export interface TurnDocsDeps {
  // `notBefore` lets a scan that began after it be reused; without it the scan is always new.
  scan(root: string, notBefore?: number): Promise<ScannedWorkspace>;
  enabled(): Promise<boolean>;
  // "session" sets files that changed while another agent's turn ran in the workspace apart in their own row;
  // "workspace" lists every changed file as a normal row. Read when a turn ends. A caller that gives none gets
  // "workspace", the behavior from before the option; the plugin's server entry always gives one.
  scope?(): Promise<TurnCardsScope>;
  now?: () => number;
  log?: (message: string) => void;
}

export type TurnCardsScope = "session" | "workspace";

// Turn windows kept per workspace at most: a turn that never reports its end must not make the list grow for good.
export const TURN_WINDOWS_MAX = 256;

// One turn of one agent. `end` is null while it runs. `settled` turns false until the turn's own card has been
// judged against the others, so the windows it needs are still there when its scan finishes.
interface Window extends TurnWindow {
  agentId: string;
  settled: boolean;
}

interface Turn {
  window: Window;
  startedAt: number;
  workspaceId: string;
  root: Promise<string>;
  baseline: Promise<Baseline | null>;
}

// One card per finished turn, listing supported documents that changed while it ran. mtime, not tool
// calls: agents write PDFs and spreadsheets from shell scripts, which no write/edit tool detail shows.
export function createTurnDocs(deps: TurnDocsDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(`[doc-viewer] ${message}`));
  const turns = new Map<string, Turn>();
  // Per workspace, in start order: the turns running and the recently ended ones they may overlap.
  const windows = new Map<string, Window[]>();

  // An ended window is needed only while some turn not yet judged started within the slack of its end: later
  // files cannot fall in it otherwise. Past the bound the oldest ended windows go first.
  const prune = (workspaceId: string) => {
    const list = windows.get(workspaceId);
    if (!list) return;
    const pending = list.filter((window) => !window.settled);
    let kept = list.filter((window) => !window.settled || pending.some((other) => other.start - TURN_WINDOW_SLACK_MS <= window.end! + TURN_WINDOW_SLACK_MS));
    let excess = kept.length - TURN_WINDOWS_MAX;
    if (excess > 0) kept = kept.filter((window) => !window.settled || excess-- <= 0);
    if (kept.length === 0) windows.delete(workspaceId);
    else windows.set(workspaceId, kept);
  };
  const settle = (workspaceId: string, window: Window, end: number) => {
    window.end ??= end;
    window.settled = true;
    prune(workspaceId);
  };

  return {
    turnStarted({ agent }: TurnStarted, host: TurnDocsHost): void {
      const startedAt = now();
      if (!agent.workspaceId) return;
      const workspaceId = agent.workspaceId;
      const root = host.resolveRoot(workspaceId);
      // The baseline tells new from changed. It leaves out what changed from the slack before startedAt on,
      // so a file the agent wrote before the scan reached it is judged by the end scan alone. No scan when
      // the setting is off. A scan begun within the slack before startedAt is reused, so turns starting
      // together share a walk, and it still holds every folder made before that.
      const baseline = root
        .then(async (dir): Promise<Baseline | null> => ((await deps.enabled()) ? baselineAt(await deps.scan(dir, startedAt - TURN_WINDOW_SLACK_MS), startedAt) : null))
        .catch(() => null);
      root.catch(() => undefined);
      // A turn whose end never came is closed here, so it stops counting as running beside the new one.
      const previous = turns.get(agent.id);
      if (previous) settle(previous.workspaceId, previous.window, startedAt);
      const window: Window = { agentId: agent.id, start: startedAt, end: null, settled: false };
      windows.set(workspaceId, [...(windows.get(workspaceId) ?? []), window]);
      turns.set(agent.id, { window, startedAt, workspaceId, root, baseline });
      prune(workspaceId);
    },

    async turnEnded({ agent, turnId, outcome }: TurnEnded, host: TurnDocsHost): Promise<TurnDocsRow | null> {
      const turn = turns.get(agent.id);
      turns.delete(agent.id);
      // Without a recorded start (the plugin loaded mid-turn) there is no window to judge.
      if (!turn) return null;
      const began = now();
      // The end is recorded before any await, so a turn ending while this card is built sees it as ended.
      turn.window.end = began;
      try {
        return (await deps.enabled()) ? await buildCard(turn, { turnId, outcome, agentId: agent.id, began }, host) : null;
      } finally {
        settle(turn.workspaceId, turn.window, began);
      }
    },

    // Windows held for a workspace; for tests and the log, not for callers' logic.
    windowCount(workspaceId: string): number {
      return windows.get(workspaceId)?.length ?? 0;
    },

    forget(agentId: string): void {
      const turn = turns.get(agentId);
      turns.delete(agentId);
      if (turn) settle(turn.workspaceId, turn.window, now());
    },
  };

  async function buildCard(turn: Turn, { turnId, outcome, agentId, began }: { turnId: string | null; outcome: TurnEnded["outcome"]; agentId: string; began: number }, host: TurnDocsHost): Promise<TurnDocsRow | null> {
    const root = await turn.root;
    const [baseline, after] = await Promise.all([turn.baseline, deps.scan(root)]);
    const candidates = after.entries.filter((entry) => entry.changedMs >= turn.startedAt - TURN_WINDOW_SLACK_MS);
    const detected = changedDuringTurn(baseline?.complete ? candidates : await withBirthtimes(root, candidates), baseline, turn.startedAt);
    // The overlapped files are set apart before folder rows are built, so a new checkout or folder folds only
    // this turn's own files and the overlapped ones stay together in the other-session row. Only other agents'
    // turns count; the list is read now, after the scans, so a turn that ended meanwhile is closed.
    const sessionScope = ((await deps.scope?.()) ?? "workspace") === "session";
    const changedAt = new Map(candidates.map((entry) => [entry.path, entry.changedMs]));
    const { own: changed, overlapped } = sessionScope ? splitOtherSessions(detected, (path) => changedAt.get(path), (windows.get(turn.workspaceId) ?? []).filter((other) => other.agentId !== agentId)) : { own: detected, overlapped: [] };
    const { files, groups } = groupChanges(changed, after, baseline, turn.startedAt);
    const row = turnDocsRow({
      workspaceId: turn.workspaceId,
      turnId,
      startedAt: turn.startedAt,
      endedAt: began,
      outcome: outcome.kind,
      files,
      groups,
      overlapped,
      partial: !after.complete,
    });
    const folded = groups.length > 0 ? ` (${changed.length - files.length} in ${groups.length} folder row(s))` : "";
    log(`turn ${turnId ?? "?"} of ${agentId.slice(0, 8)}: ${changed.length} changed document(s)${overlapped.length > 0 ? `, ${overlapped.length} more possibly from another session` : ""}${folded}, scan ${now() - began} ms${after.complete ? "" : " (partial)"}`);
    if (row) await host.append(agentId, row);
    return row;
  }
}

async function withBirthtimes(root: string, files: readonly ScannedFile[]): Promise<ScannedFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const info = await stat(join(root, file.path)).catch(() => null);
      return info ? { ...file, birthtimeMs: info.birthtimeMs } : file;
    }),
  );
}

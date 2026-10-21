import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { docsAnyRpc } from "../shared/rpc";

// FileText reads as "documents" at header size; FileStack looked like a copy button on phones.
// The SDK does not say which workspaces are on screen, so every known workspace is
// probed with docs.any, which stops at the first document, a few at a time.
// Failures back off up to the cap. An agent whose turn just ended is the usual source of a first
// document, so its workspace is probed again at once if the button is hidden. Turn ends come from
// one agent-list subscription (pushed updates), so this adds no polling.
export const HEADER_POLL_MS = 2 * 60_000;
export const HEADER_POLL_MAX_MS = 10 * 60_000;
const MAX_CONCURRENT_PROBES = 2;
// Busy workspaces end many turns; a workspace with no documents is scanned at most this often for them.
export const TURN_RECHECK_MIN_MS = 10_000;

type HeaderButtonHost = Pick<PluginClientContext, "paseo" | "rpc" | "addHeaderButton">;
type AgentUpdate =
  | { kind: "upsert"; agent: { id: string; status: string; workspaceId?: string | null } }
  | { kind: "remove"; agentId: string };

interface WorkspaceProbe {
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  probing: boolean;
  // A turn ended while a probe was running, which may have missed the new file.
  again: boolean;
  refresh(): Promise<void>;
}

export function addDocumentsHeaderButtons(client: HeaderButtonHost, showDocuments: (workspaceId: string) => void): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  const workspaces = new Map<string, WorkspaceProbe>();
  let stopped = false;
  let stop = () => {};
  let probing = 0;
  const queued: (() => void)[] = [];
  const probe = async <T>(work: () => Promise<T>): Promise<T> => {
    if (probing < MAX_CONCURRENT_PROBES) probing++;
    else await new Promise<void>((start) => queued.push(start));
    try {
      return await work();
    } finally {
      const next = queued.shift();
      if (next) next();
      else probing--;
    }
  };

  const add = (workspaceId: string) => {
    if (buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "documents",
      workspaceId,
      button: {
        title: "Show documents",
        icon: "FileText",
        label: "Documents",
        behavior: { kind: "action", onPress: () => showDocuments(workspaceId) },
      },
    });
    buttons.set(workspaceId, registration);
  };
  const remove = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  const forget = (workspaceId: string) => {
    const state = workspaces.get(workspaceId);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    workspaces.delete(workspaceId);
    remove(workspaceId);
  };
  const observe = (workspaceId: string) => {
    if (workspaces.has(workspaceId)) return;
    let delay = HEADER_POLL_MS;
    const current = () => !stopped && workspaces.get(workspaceId) === state;
    const refresh = async () => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.probing = true;
      state.startedAt = Date.now();
      try {
        const found = await probe(async () => (current() ? (await client.rpc(docsAnyRpc, { workspaceId })).found : null));
        if (found === null || !current()) return;
        if (found) add(workspaceId);
        else remove(workspaceId);
        delay = HEADER_POLL_MS;
      } catch {
        // Keep the last known state during a failure; retry later.
        delay = Math.min(delay * 2, HEADER_POLL_MAX_MS);
      } finally {
        state.probing = false;
        const again = state.again;
        state.again = false;
        if (current()) {
          if (again && !buttons.has(workspaceId)) void refresh();
          else state.timer = setTimeout(() => void refresh(), delay);
        }
      }
    };
    const state: WorkspaceProbe = { startedAt: 0, probing: false, again: false, refresh };
    workspaces.set(workspaceId, state);
    void refresh();
  };
  const turnEnded = (workspaceId: string) => {
    const state = workspaces.get(workspaceId);
    if (!state || buttons.has(workspaceId)) return;
    if (state.probing) {
      state.again = true;
      return;
    }
    const wait = state.startedAt + TURN_RECHECK_MIN_MS - Date.now();
    if (wait <= 0) {
      void state.refresh();
      return;
    }
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => void state.refresh(), wait);
  };
  const statuses = new Map<string, string>();
  const agentChanged = (update: AgentUpdate) => {
    if (update.kind !== "upsert") {
      statuses.delete(update.agentId);
      return;
    }
    const { id, status, workspaceId } = update.agent;
    const previous = statuses.get(id);
    statuses.set(id, status);
    if (previous === "running" && status !== "running" && workspaceId) turnEnded(workspaceId);
  };
  // agents.subscribe only relays updates from agent subscriptions opened through this API, not the
  // app's own, so the plugin opens one: pushed updates, no polling. Older hosts fall back to the poll.
  let stopTurns = () => {};
  const agentList = typeof client.paseo.agents?.list === "function"
    ? Promise.resolve().then(() => client.paseo.agents.list({ subscribe: {} }))
    : Promise.reject(new Error("this host has no agent list"));
  agentList
    .then(({ entries, subscription }) => {
      if (stopped) {
        void subscription.release();
        return;
      }
      for (const { agent } of entries) statuses.set(agent.id, agent.status);
      const unsubscribe = subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "agent_update") agentChanged(message.payload as AgentUpdate);
        },
      });
      stopTurns = () => {
        unsubscribe();
        void subscription.release();
      };
    })
    .catch((error: unknown) => {
      if (!stopped) console.warn("Documents header button: agent updates unavailable", error);
    });

  client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release();
        return;
      }
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries }) => {
          const ids = new Set(entries.map((workspace) => workspace.id));
          for (const id of [...workspaces.keys()]) if (!ids.has(id)) forget(id);
          for (const id of ids) observe(id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") observe(update.workspace.id);
          else forget(update.id);
        },
      });
      stop = () => {
        unsubscribe();
        void subscription.release();
      };
    })
    .catch((error: unknown) => {
      if (!stopped) console.warn("Documents header button: workspace list unavailable", error);
    });

  return () => {
    stopped = true;
    stop();
    stopTurns();
    for (const id of [...workspaces.keys()]) forget(id);
  };
}

import type { PluginButton, PluginClientContext, PluginHeaderButtonContribution } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDocumentsHeaderButtons, HEADER_POLL_MAX_MS, HEADER_POLL_MS, TURN_RECHECK_MIN_MS } from "../client/header-button";
import { docsAnyRpc } from "../shared/rpc";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

interface Observer {
  snapshot(snapshot: { entries: { id: string }[] }): void;
  update(message: unknown): void;
}

function fakeClient() {
  const live = new Map<string, PluginButton>();
  let observer: Observer | null = null;
  let resolveList!: () => void;
  const release = vi.fn(async () => {});
  const showDocuments = vi.fn();
  let agentObserver: { update(message: unknown): void } | null = null;
  const stopAgents = vi.fn(async () => void (agentObserver = null));
  const listed = new Promise<void>((resolve) => (resolveList = resolve));
  const client = {
    rpc: vi.fn(async (_contract: unknown, _request: unknown) => ({ found: true })),
    addHeaderButton: vi.fn(({ workspaceId, button }: PluginHeaderButtonContribution) => {
      if (live.has(workspaceId)) throw new Error(`duplicate header button for ${workspaceId}`);
      live.set(workspaceId, button);
      return { update: vi.fn(), remove: () => void live.delete(workspaceId) };
    }),
    paseo: {
      agents: {
        // A local listener that would only hear subscriptions opened by the plugin itself.
        subscribe: vi.fn(() => () => {}),
        list: vi.fn(async () => ({
          entries: [{ agent: { id: "busy", status: "running", workspaceId: "ws-1" } }],
          subscription: {
            subscribe: (next: { update(message: unknown): void }) => {
              agentObserver = next;
              return () => {};
            },
            release: stopAgents,
          },
        })),
      },
      workspaces: {
        list: vi.fn(async () => {
          await listed;
          return {
            entries: [],
            subscription: {
              subscribe: (next: Observer) => {
                observer = next;
                return () => (observer = null);
              },
              release,
            },
          };
        }),
      },
    },
  };
  const settle = async () => {
    resolveList();
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    client: client as unknown as Pick<PluginClientContext, "paseo" | "rpc" | "addHeaderButton">,
    rpc: client.rpc,
    showDocuments,
    list: client.paseo.workspaces.list,
    live,
    release,
    settle,
    observer: () => observer,
    agentUpdate: (update: unknown) => agentObserver?.update({ type: "agent_update", payload: update }),
    agentList: client.paseo.agents.list,
    stopAgents,
  };
}

const upsert = (id: string) => ({ type: "workspace_update", payload: { kind: "upsert", workspace: { id } } });
const removal = (id: string) => ({ type: "workspace_update", payload: { kind: "remove", id } });

describe("Documents header button", () => {
  it("stays hidden for empty workspaces and follows document creation and deletion", async () => {
    const fake = fakeClient();
    fake.rpc.mockResolvedValue({ found: false });
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    expect(fake.rpc).toHaveBeenCalledWith(docsAnyRpc, { workspaceId: "ws-1" });
    expect(fake.live.size).toBe(0);

    fake.rpc.mockResolvedValue({ found: true });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);

    fake.rpc.mockRejectedValueOnce(new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);

    fake.rpc.mockResolvedValue({ found: false });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect(fake.live.size).toBe(0);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off polling while a workspace keeps failing, then resumes the normal interval", async () => {
    const fake = fakeClient();
    fake.rpc.mockRejectedValue(new Error("unavailable"));
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // First call, retries at 4 and 12 minutes, then every 10 minutes.
    expect(HEADER_POLL_MS).toBe(2 * 60_000);
    expect(fake.rpc).toHaveBeenCalledTimes(1 + 2 + Math.floor((30 * 60_000 - 12 * 60_000) / HEADER_POLL_MAX_MS));
    fake.rpc.mockResolvedValue({ found: false });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MAX_MS);
    const calls = fake.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect(fake.rpc).toHaveBeenCalledTimes(calls + 1);
    cleanup();
  });

  it("discards pending results after removal, re-addition, and cleanup", async () => {
    const fake = fakeClient();
    let resolve!: (result: { found: boolean }) => void;
    fake.rpc.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    fake.observer()!.update(removal("ws-1"));
    fake.rpc.mockResolvedValue({ found: false });
    fake.observer()!.update(upsert("ws-1"));
    resolve({ found: true });
    await fake.settle();
    expect(fake.live.size).toBe(0);

    let finish!: (result: { found: boolean }) => void;
    fake.rpc.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    cleanup();
    finish({ found: true });
    await fake.settle();
    expect(fake.live.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("adds one Documents button to each nonempty workspace header, following the workspace list", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    expect(fake.list).toHaveBeenCalledWith({ subscribe: {} });
    await fake.settle();

    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }, { id: "ws-2" }] });
    await fake.settle();
    expect([...fake.live.keys()]).toEqual(["ws-1", "ws-2"]);

    fake.observer()!.update(upsert("ws-2"));
    fake.observer()!.update(upsert("ws-3"));
    fake.observer()!.update(removal("ws-1"));
    fake.observer()!.update({ type: "agent_update", payload: { kind: "remove", agentId: "ws-2" } });
    await fake.settle();
    expect([...fake.live.keys()].sort()).toEqual(["ws-2", "ws-3"]);

    fake.observer()!.snapshot({ entries: [{ id: "ws-3" }, { id: "ws-4" }] });
    await fake.settle();
    expect([...fake.live.keys()].sort()).toEqual(["ws-3", "ws-4"]);
  });

  it("checks at most two workspaces at a time", async () => {
    const fake = fakeClient();
    const pending: ((result: { found: boolean }) => void)[] = [];
    fake.rpc.mockImplementation(() => new Promise((done) => pending.push(done)));
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"].map((id) => ({ id })) });
    await fake.settle();
    expect(fake.rpc).toHaveBeenCalledTimes(2);
    pending.shift()!({ found: true });
    await fake.settle();
    expect(fake.rpc).toHaveBeenCalledTimes(3);
    fake.observer()!.update(removal("ws-4"));
    while (pending.length) { pending.shift()!({ found: true }); await fake.settle(); }
    expect(fake.rpc.mock.calls.map(([, input]) => (input as { workspaceId: string }).workspaceId)).toEqual(["ws-1", "ws-2", "ws-3", "ws-5"]);
    expect([...fake.live.keys()].sort()).toEqual(["ws-1", "ws-2", "ws-3", "ws-5"]);
    cleanup();
  });

  it("shows Documents for that workspace", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    const button = fake.live.get("ws-1")!;
    expect(button).toMatchObject({ title: "Show documents", icon: "FileText", label: "Documents" });
    if (button.behavior.kind !== "action") throw new Error("expected an action button");
    await button.behavior.onPress();
    expect(fake.showDocuments).toHaveBeenCalledWith("ws-1");
  });

  it("removes its buttons and releases the workspace subscription on cleanup", async () => {
    const fake = fakeClient();
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    cleanup();
    expect(fake.live.size).toBe(0);
    expect(fake.observer()).toBeNull();
    expect(fake.release).toHaveBeenCalled();
  });

  it("releases a subscription that arrives after cleanup without adding buttons", async () => {
    const fake = fakeClient();
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    cleanup();
    await fake.settle();
    expect(fake.release).toHaveBeenCalled();
    expect(fake.observer()).toBeNull();
    expect(fake.live.size).toBe(0);
  });

  it("keeps the plugin working when the workspace list cannot be observed", async () => {
    const fake = fakeClient();
    fake.list.mockRejectedValueOnce(new Error("socket closed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => addDocumentsHeaderButtons(fake.client, fake.showDocuments)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.live.size).toBe(0);
    warn.mockRestore();
  });
});

const agentStatus = (id: string, status: string, workspaceId = "ws-1") => ({ kind: "upsert", agent: { id, status, workspaceId } });

describe("Documents header button after an agent turn", () => {
  async function hiddenWorkspace() {
    const fake = fakeClient();
    fake.rpc.mockResolvedValue({ found: false });
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    await vi.advanceTimersByTimeAsync(TURN_RECHECK_MIN_MS);
    fake.rpc.mockClear();
    return { fake, cleanup };
  }

  it("probes again as soon as a turn ends, without waiting for the poll", async () => {
    const { fake, cleanup } = await hiddenWorkspace();
    fake.rpc.mockResolvedValue({ found: true });
    fake.agentUpdate(agentStatus("a", "running"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).not.toHaveBeenCalled();
    fake.agentUpdate(agentStatus("a", "idle"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.live.has("ws-1")).toBe(true);
    // Once the button shows, a turn end costs nothing.
    fake.agentUpdate(agentStatus("a", "running"));
    fake.agentUpdate(agentStatus("a", "idle"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.agentList).toHaveBeenCalledWith({ subscribe: {} });
    cleanup();
    expect(fake.stopAgents).toHaveBeenCalled();
  });

  it("keeps polling on a host without the agent list", async () => {
    const fake = fakeClient();
    delete (fake.client.paseo as { agents?: unknown }).agents;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanup = addDocumentsHeaderButtons(fake.client, fake.showDocuments);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    expect(fake.live.has("ws-1")).toBe(true);
    cleanup();
    warn.mockRestore();
  });

  it("knows agents already running when it starts, so their first turn end counts", async () => {
    const { fake, cleanup } = await hiddenWorkspace();
    fake.agentUpdate(agentStatus("busy", "idle"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("ignores updates that are not a turn ending and agents of unknown workspaces", async () => {
    const { fake, cleanup } = await hiddenWorkspace();
    fake.agentUpdate(agentStatus("a", "idle"));
    fake.agentUpdate(agentStatus("a", "idle"));
    fake.agentUpdate(agentStatus("b", "running", "elsewhere"));
    fake.agentUpdate(agentStatus("b", "idle", "elsewhere"));
    fake.agentUpdate({ kind: "remove", agentId: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).not.toHaveBeenCalled();
    cleanup();
  });

  it("scans a workspace without documents at most once per interval for turn ends", async () => {
    const { fake, cleanup } = await hiddenWorkspace();
    for (const status of ["running", "idle"]) fake.agentUpdate(agentStatus("a", status));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    for (const status of ["running", "idle", "running", "error"]) fake.agentUpdate(agentStatus("a", status));
    await vi.advanceTimersByTimeAsync(TURN_RECHECK_MIN_MS - 1);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.rpc).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("probes again when a turn ends during a probe that may have missed the file", async () => {
    const { fake, cleanup } = await hiddenWorkspace();
    let answer!: (value: { found: boolean }) => void;
    fake.rpc.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    fake.agentUpdate(agentStatus("a", "running"));
    fake.agentUpdate(agentStatus("a", "idle"));
    await vi.advanceTimersByTimeAsync(0);
    fake.rpc.mockResolvedValue({ found: true });
    fake.agentUpdate(agentStatus("b", "running"));
    fake.agentUpdate(agentStatus("b", "idle"));
    answer({ found: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledTimes(2);
    expect(fake.live.has("ws-1")).toBe(true);
    cleanup();
  });
});

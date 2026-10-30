import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginFileEvent, PluginFilePanelContribution } from "@getpaseo/plugin/client";
import { DocumentScreen } from "../../client/document-screen";
import { createDocumentsPanel } from "../../client/documents-panel";
import { addFilePanel } from "../../client/file-panel";
import { FilePanelReader } from "../../client/file-panel-reader";
import { setHostClient } from "../../client/host-client";
import { createDocumentRouting } from "../../client/open-target";
import { createPanelReader } from "../../client/panel-reader";
import { ReviewScreen } from "../../client/review-screen";
import { createTurnDocsCard, legacyTurnDocsCard } from "../../client/turn-docs-card";
import { viewerSettingsRpc } from "../../shared/settings";
import { callRpc, recordCall } from "./plugin-shim";
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const light = new URLSearchParams(location.search).has("light");
const theme = { colors: light
  ? { foreground: "#111827", foregroundMuted: "#4b5563", surface0: "#ffffff", surface1: "#f3f4f6", surface2: "#e5e7eb", border: "#d1d5db", accent: "#4f46e5", accentForeground: "#fff", statusDanger: "#b91c1c", statusWarning: "#92400e", statusSuccess: "#047857" }
  : { foreground: "#e5e7eb", foregroundMuted: "#9ca3af", surface0: "#111827", surface1: "#1f2937", surface2: "#374151", border: "#4b5563", accent: "#6366f1", accentForeground: "#fff", statusDanger: "#f87171", statusWarning: "#fbbf24", statusSuccess: "#34d399" } };
// Fake agents: "racing" reads as idle in the list but busy when re-checked at submission,
// and "broken" rejects the send, so both must leave the draft in place.
const agent = (id: string, title: string, status: string, updatedAt: string, workspaceId = "workspace") =>
  ({ id, title, status, updatedAt, workspaceId, provider: "claude", pendingPermissions: [] });
const agents = [
  agent("busy", "Busy agent", "running", "2026-10-17T12:00:00.000Z"),
  agent("docs", "Docs agent", "idle", "2026-10-17T11:00:00.000Z"),
  agent("racing", "Racing agent", "idle", "2026-10-17T10:00:00.000Z"),
  agent("broken", "Broken agent", "idle", "2026-10-17T09:00:00.000Z"),
  agent("elsewhere", "Other workspace agent", "idle", "2026-10-17T13:00:00.000Z", "other"),
];
const sent: unknown[] = [];
(window as any).__sentReviews = sent;
// Replaces the agent, so the next agent list poll sees a changed entry.
(window as any).__setAgentStatus = (id: string, status: string) => {
  const index = agents.findIndex((each) => each.id === id);
  agents[index] = { ...agents[index], status };
};
(globalThis as any).__fakePaseo = { agents: {
  // Logged with the RPC calls, so a check can wait for a list that started after a status change.
  list: () => recordCall("agents.list", {}, async () => ({ entries: agents.map((each) => ({ agent: each })) })),
  ref: (id: string) => ({
    refresh: async () => { const found = agents.find((each) => each.id === id); return found ? { agent: id === "racing" ? { ...found, status: "running" } : found } : null; },
    send: async (text: string, options: unknown) => { if (id === "broken") throw new Error("sendAgentMessage rejected"); sent.push({ id, text, options }); },
  }),
} };
// ?compact renders the phone layout at phone width, for toolbar fit checks.
const compact = new URLSearchParams(location.search).has("compact");
const frameWidth = compact ? 390 : Number(new URLSearchParams(location.search).get("width") ?? 950);
// ?settingsFail makes openSettings throw, as a host does when it cannot open the screen.
const settingsFail = new URLSearchParams(location.search).has("settingsFail");
const openedSettings: string[] = [];
(window as any).__openedSettings = openedSettings;
type OpenScreenInput = { screenId: string; params?: Record<string, string> };
let openScreen = (input: OpenScreenInput) => { (window as any).__openedScreen = input; };
// Turn cards route like the plugin, with the page as the window. Opening Documents is only recorded:
// the Documents button shows it, with the document chosen for it.
const reader = createPanelReader();
const routing = createDocumentRouting({
  openScreen: (input) => openScreen(input),
  openPanel: (id, options) => { (window as any).__openedPanel = { id, ...options }; },
  readSettings: () => callRpc(viewerSettingsRpc.read, {}) as Promise<any>,
  windowWidth: () => window.innerWidth,
}, reader);
const TurnCard = createTurnDocsCard({
  ...routing,
  openSettings: (id: string) => { if (settingsFail) throw new Error("No settings screen"); openedSettings.push(id); },
  rpc: callRpc,
} as any);
const LegacyTurnCard = legacyTurnDocsCard(TurnCard);
// ?file=<absolute path> mounts the panel the plugin registers with addFilePanel, as a Paseo 0.13.0 file tab
// does. The viewer watches the handle but reads through its own RPCs; calls on the handle and tab are recorded.
const fileCalls: string[] = [];
(window as any).__fileCalls = fileCalls;
const fileWatchers = new Set<(event: PluginFileEvent) => void>();
(window as any).__fileEvent = (type: PluginFileEvent["type"]) => {
  for (const listener of fileWatchers) listener({ type });
};
(window as any).__fileWatcherCount = () => fileWatchers.size;
function pluginFile(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const unused = (method: string) => () => { fileCalls.push(method); return Promise.reject(new Error(`${method} is not used by the viewer`)); };
  return { path, name, extension: name.slice(name.lastIndexOf(".") + 1).toLowerCase(), size: 0, modifiedAt: "", mimeType: "application/octet-stream",
    readText: unused("readText"), readBytes: unused("readBytes"), url: unused("url"), writeText: unused("writeText"), writeBytes: unused("writeBytes"),
    watch: (listener: (event: PluginFileEvent) => void) => {
      fileCalls.push("watch");
      fileWatchers.add(listener);
      return () => { fileCalls.push("unwatch"); fileWatchers.delete(listener); };
    } };
}
const filePath = new URLSearchParams(location.search).get("file");
const file = filePath ? pluginFile(filePath) : null;
const tab = { setModified: (modified: boolean) => fileCalls.push(`setModified(${modified})`), state: undefined, setState: () => fileCalls.push("setState") };
let filePanel: PluginFilePanelContribution | null = null;
addFilePanel({ addFilePanel: (contribution: PluginFilePanelContribution) => { filePanel = contribution; return () => {}; } } as any, FilePanelReader);
function App() {
  const [path, setPath] = useState("statement.pdf");
  const [siblings, setSiblings] = useState<string | undefined>(undefined);
  const [turnDocs, setTurnDocs] = useState<unknown>(null);
  useEffect(() => { void fetch("/turn-docs").then((response) => response.json()).then(setTurnDocs); }, []);
  const [checkoutDocs, setCheckoutDocs] = useState<unknown>(null);
  useEffect(() => { void fetch("/turn-docs-checkout").then((response) => response.json()).then(setCheckoutDocs); }, []);
  const [opened, setOpened] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [Panel] = useState(() => createDocumentsPanel((input) => { (window as any).__openedScreen = input; setPath(input.params!.path!); setSiblings(input.params!.siblings); setBrowsing(false); setOpened(true); }, reader));
  const [screen, setScreen] = useState("document");
  useEffect(() => {
    openScreen = (input) => {
      (window as any).__openedScreen = input;
      if (input.screenId === "document" && input.params?.path) { setPath(input.params.path); setSiblings(input.params.siblings); setBrowsing(false); setOpened(true); }
      setScreen(input.screenId);
    };
    setHostClient({ openScreen } as any);
    return () => setHostClient(null);
  }, []);
  const props = { host: {} as any, theme: theme as any, layout: { compact } as any, navigation: { openAgent: ({ agentId }: { agentId: string }) => { (window as any).__openedAgent = agentId; } } as any };
  return <QueryClientProvider client={query}>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>{["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "tone.wav", "clip.mp4", "audible.webm", "animated.webp", "broken.pdf", "many.csv", "long.pdf", "report.pdf", "forecast.xlsx", "evals.jsonl", ".env"].map((file) => <button key={file} onClick={() => { setPath(file); setSiblings(undefined); setOpened(true); setBrowsing(false); setScreen("document"); }}>{file}</button>)}
      <button onClick={() => { setBrowsing(true); setScreen("document"); }}>Documents</button>
      <button onClick={() => setScreen("turn-card")}>Turn card</button>
      <button onClick={() => setScreen("checkout-card")}>Checkout card</button>
      <button onClick={() => setOpened(!opened)}>{opened ? "Close viewer" : "Reopen viewer"}</button></nav>
    <main style={{ display: "flex", height: 780, width: frameWidth }}>{file && filePanel ? (opened ? <FilePanel panel={filePanel} {...props} workspaceId="workspace" file={file} tab={tab} params={{ path: file.path }} revision={0} /> : null)
      : screen === "turn-card"
      ? <div aria-label="Turn card frame" style={{ width: "100%" }}>{turnDocs ? <LegacyTurnCard {...props} agentId="docs" timestamp={new Date(0)} item={{ type: "plugin", kind: "turn-docs", version: 1, data: turnDocs } as any} /> : null}</div>
      : screen === "checkout-card"
      ? <div aria-label="Turn card frame" style={{ width: "100%" }}>{checkoutDocs ? <TurnCard {...props} agentId="docs" timestamp={new Date(0)} item={{ type: "plugin", kind: "turn-docs", version: 2, data: checkoutDocs } as any} /> : null}</div>
      : screen === "review"
      ? <ReviewScreen {...props} params={{ workspaceId: "workspace" }} />
      : browsing ? <Panel context="workspace" workspaceId="workspace" theme={theme as any} layout={{ compact } as any} {...({} as any)} />
      : opened ? <DocumentScreen key={siblings ? "turn-card" : path} {...props} params={siblings ? { workspaceId: "workspace", path, siblings } : { workspaceId: "workspace", path }} /> : null}</main>
  </QueryClientProvider>;
}
function FilePanel({ panel, ...props }: { panel: PluginFilePanelContribution } & Record<string, any>) {
  return <panel.Component {...(props as any)} />;
}
createRoot(document.getElementById("root")!).render(<App />);

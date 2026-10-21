import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, statSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { revisionOf } from "../../server/revision";
import contribute from "../../index.server";
import { scanIssues, searchDocument } from "../../server/documents";
import { scannedDocuments } from "../../server/recent";
import { searchGenerations } from "../../server/search";
import { readFileSync } from "node:fs";
import { DOCUMENT_RPCS } from "../../shared/rpc";
import { viewerSettingsRpc } from "../../shared/settings";
const generated = process.env.VIEWER_BROWSER_DIR!;
const root = mkdtempSync(join(tmpdir(), "viewer-browser-files-"));
for (const file of ["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "clip.mp4", "audible.webm", "animated.webp"]) copyFileSync(join(process.cwd(), "test/fixtures", file), join(root, file));
copyFileSync(join(generated, "searchable.pdf"), join(root, "statement.pdf"));
copyFileSync(join(generated, "long.pdf"), join(root, "long.pdf"));
copyFileSync(join(generated, "report.pdf"), join(root, "report.pdf"));
copyFileSync(join(generated, "forecast.xlsx"), join(root, "forecast.xlsx"));
for (const [from, to] of [[join(generated, "report.pdf"), "reports/quarterly-report-with-a-long-file-name.pdf"], [join(generated, "forecast.xlsx"), "finance/forecast.xlsx"], [join(process.cwd(), "test/fixtures/photo.png"), "screenshots/photo.png"]]) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(from, join(root, to));
}
const turnFiles = [["reports/quarterly-report-with-a-long-file-name.pdf", "pdf", "new"], ["finance/forecast.xlsx", "xlsx", "changed"], ["screenshots/photo.png", "image-raster", "new"], ["animated.webp", "image-decoded", "changed"]] as const;
const checkoutFiles = Array.from({ length: 12 }, (_, index) => index === 0 ? ["paseo-doc-viewer-gallery/docs/guide.pdf", "pdf"] : [`paseo-doc-viewer-gallery/assets/shot-${index}.png`, "image-raster"]);
const exportFiles = Array.from({ length: 12 }, (_, index) => [`exports/run-${index + 1}.csv`, "csv"]);
for (const [path] of checkoutFiles) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  copyFileSync(path.endsWith(".pdf") ? join(generated, "report.pdf") : join(process.cwd(), "test/fixtures/photo.png"), join(root, path));
}
mkdirSync(join(root, "archive/2025/q4"), { recursive: true });
copyFileSync(join(generated, "report.pdf"), join(root, "archive/2025/q4/ledger.pdf"));
utimesSync(join(root, "archive/2025/q4/ledger.pdf"), new Date("2025-12-01"), new Date("2025-12-01"));
mkdirSync(join(root, "exports"), { recursive: true });
for (const [path] of exportFiles) writeFileSync(join(root, path), "a,b\n1,2\n");
writeFileSync(join(root, "broken.pdf"), "original unsupported file");
writeFileSync(join(root, ".env"), "SECRET=1");
writeFileSync(join(root, "analysis.ipynb"), "{}");
// Eval results as JSON Lines: nested objects, an array, a long model output and one unreadable line.
const longOutput = `The answer is 4. ${"Step by step reasoning follows. ".repeat(200)}END-OF-ANSWER`;
writeFileSync(join(root, "evals.jsonl"), [
  JSON.stringify({ id: "case-1", input: "What is 2+2?", output: longOutput, meta: { model: "model-a", latency_ms: 120 }, tags: ["math"], passed: true }),
  JSON.stringify({ id: "case-2", input: "Capital of France?", output: "Paris", meta: { model: "model-b", latency_ms: 340 }, tags: ["geo", "easy"], passed: false }),
  '{"id": "case-3", "output": ',
  JSON.stringify({ id: "case-4", input: "Spell cat", output: "c-a-t", meta: { model: "model-b", latency_ms: 90 }, tags: [], passed: true }),
].join("\n") + "\n");
writeFileSync(join(root, "many.csv"), Array.from({ length: 120 }, (_, row) => `row ${row},needle`).join("\n"));
const bytes = Buffer.alloc(44 + 16000);
bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 8000), 44 + i * 2);
writeFileSync(join(root, "tone.wav"), bytes);
const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
contribute({ registerSettings: () => ({ read: async () => ({ status: "ready", revision: "", values: { turnCards: true } }), subscribe: () => () => {} }), on: () => () => {}, handle: (contract: any, handler: any) => handlers.set(contract.name, handler) } as any);
// A tiny budget makes every search span many requests, so the client must keep going on its own.
handlers.set("doc.search", async ({ path, password, query, cursor, searchId }) =>
  searchDocument({ root, path, password }, query, cursor, 1, searchId && searchGenerations.begin(searchId.session, searchId.generation)));
// A five-row cap makes the issue check pause, so the client must show coverage and continue on request.
handlers.set("doc.issues", async ({ path, cursor }) => scanIssues({ root, path }, cursor, { budgetMs: 60_000, maxRows: 5, maxIssues: 200 }));
// The open choice starts answered, so the first-open chooser shows only where a check asks for it.
let settingsValues: Record<string, unknown> = { turnCards: true, kindColors: true, openDocuments: "full" };
let settingsRevision = 1;
handlers.set(viewerSettingsRpc.read.name, async () => ({ status: "ready", revision: String(settingsRevision), values: settingsValues }));
handlers.set(viewerSettingsRpc.write.name, async ({ revision, values }) => {
  if (revision !== String(settingsRevision)) return { status: "conflict", error: "stale" };
  settingsValues = values;
  return { status: "saved", revision: String(++settingsRevision), values };
});
const contracts = [...DOCUMENT_RPCS, viewerSettingsRpc.read, viewerSettingsRpc.write];
const paseo = { workspaces: { list: async () => ({ entries: [{ id: "workspace", workspaceDirectory: root }], pageInfo: { hasMore: false } }) } };
const turnFile = (files: readonly (readonly string[])[]) =>
  files.map(([path, kind, status]) => { const info = statSync(join(root, path!)); return { path, kind, status, size: info.size, revision: revisionOf(info) }; });
const server = createServer(async (request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("Content-Type", "application/javascript"); response.end(readFileSync(join(generated, "app.js"))); return; }
  // Simulates an agent rewriting a file: a new modified time gives it a new revision.
  if (request.url === "/touch/statement.pdf") { const later = new Date(Date.now() + 60_000); utimesSync(join(root, "statement.pdf"), later, later); response.end("ok"); return; }
  const openDocuments = request.url?.match(/^\/settings\?openDocuments=(\w+)$/)?.[1];
  if (openDocuments) { const { openDocuments: _, ...rest } = settingsValues; settingsValues = openDocuments === "unset" ? rest : { ...rest, openDocuments }; settingsRevision++; response.end("ok"); return; }
  if (request.url?.startsWith("/settings?")) { settingsValues = { ...settingsValues, kindColors: !request.url.endsWith("kindColors=0") }; settingsRevision++; response.end("ok"); return; }
  if (request.url === "/turn-docs") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ workspaceId: "workspace", startedAt: 0, endedAt: 1, outcome: "completed", partial: false, moreCount: 2, files: turnFile(turnFiles) }));
    return;
  }
  if (request.url === "/turn-docs-checkout") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ workspaceId: "workspace", startedAt: 0, endedAt: 1, outcome: "completed", partial: false, moreCount: 0,
      files: turnFile([["reports/quarterly-report-with-a-long-file-name.pdf", "pdf", "new"], ["finance/forecast.xlsx", "xlsx", "new"]]),
      groups: [
        { reason: "checkout", path: "paseo-doc-viewer-gallery", count: 65, files: turnFile(checkoutFiles.map(([path, kind]) => [path, kind, "new"])) },
        { reason: "folder", path: "exports", count: 13, files: turnFile(exportFiles.map(([path, kind]) => [path, kind, "new"])) },
      ] }));
    return;
  }
  // Simulates an agent's turn ending after it wrote files: the plugin then rescans the workspace, so the
  // next list reads the files as they are now instead of a scan cached from before the write.
  if (request.url === "/turn-ended") { await scannedDocuments(root); response.end("ok"); return; }
  if (request.url !== "/rpc") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Viewer test harness</title></head><body style="background:#111827;color:#e5e7eb;font-family:system-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
  try {
    let body = ""; for await (const part of request) body += part;
    const { method, input } = JSON.parse(body);
    const contract = contracts.find((rpc) => rpc.name === method)!;
    const output = await handlers.get(method)!(contract.input.parse(input), { paseo });
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(contract.output.parse(output)));
  } catch (error) { response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ...(server.address() as object), root }) + "\n"));
process.on("SIGTERM", () => { server.close(); rmSync(root, { recursive: true, force: true }); process.exit(0); });

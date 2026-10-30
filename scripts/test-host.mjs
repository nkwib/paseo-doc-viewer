import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect as baseExpect } from "@playwright/test";
import { agentTimeline, assertSafeHome, assertSafePort, daemonDown, daemonUp, PaseoWeb, pluginRows, runFakeAgentTurn, sendFakeAgentTurn } from "paseo-plugin-devkit";

const expect = baseExpect.configure({ timeout: 20_000 });
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(process.env.HOST_VERIFY_DIR ?? await mkdtemp(join(tmpdir(), "viewer-host-artifacts-")));
const workspace = await mkdtemp(join(tmpdir(), "viewer-host-workspace-"));
const state = await mkdtemp(join(tmpdir(), "viewer-host-devkit-"));
const name = `viewer-host-${process.pid}`;
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("paseo-plugin-devkit")));
process.env.PPD_STATE_DIR = state;
process.env.XDG_STATE_HOME = join(state, "plugin-state");

// All CLI operations go through the devkit, which pins a marked temporary home and removes the
// calling agent's Paseo environment. The real app evaluates registrations during the UI checks.
function paseo(...args) {
  const output = execFileSync(process.execPath, [cli, "paseo", "--name", name, "--", ...args, "--json"], {
    encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  const value = JSON.parse(output);
  if (value.error) throw new Error(value.error.message ?? JSON.stringify(value.error));
  return value;
}

let web;
let phone;
const checks = [];
const passed = (text) => { checks.push(text); console.log(`PASS ${text}`); };
try {
  await mkdir(artifacts, { recursive: true });
  for (const file of ["statement.pdf", "contract.docx", "invoices.xlsx", "deck.pptx"]) {
    await copyFile(join(plugin, "test/fixtures", file), join(workspace, file));
  }
  const daemon = await daemonUp({ name, fakeAgent: true, log: console.log });
  assertSafeHome(daemon.home);
  assertSafePort(daemon.port);
  console.log(`Isolated Paseo ${daemon.paseoVersion}: ${daemon.url}, ${daemon.home}`);
  const installed = paseo("plugin", "install", plugin);
  assert.equal(installed.status, "running");
  const turn = runFakeAgentTurn([
    { write: { path: "live.csv", content: "Name,Value\nBefore rewrite,1\n" } },
    { say: `[Open report](${join(workspace, "statement.pdf")})` },
  ], { name, cwd: workspace });
  const workspaces = paseo("workspace", "ls");
  const selected = workspaces.find((entry) => entry.cwd === workspace);
  assert.ok(selected, "the fake agent created a sample workspace");
  const { serverId } = paseo("daemon", "status");
  web = await PaseoWeb.launch({ url: daemon.url, viewport: { width: 1400, height: 1000 } });
  const page = web.page;
  await web.openWorkspace(serverId, selected.workspaceId);
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Browse workspace files", exact: true }).click();
  const openFile = async (file) => {
    await page.getByText(file, { exact: true }).last().dblclick();
    await expect(page.getByRole("button", { name: file, exact: true })).toBeVisible();
  };
  const pdfField = page.getByRole("textbox", { name: "Page number of 3", exact: true });
  await openFile("statement.pdf");
  await expect(pdfField).toHaveValue("1");
  await expect(page.getByRole("progressbar", { name: "Loading", exact: true })).toHaveCount(0);
  // Pin the host's preview tab before opening another document.
  await page.getByRole("button", { name: "statement.pdf", exact: true }).dblclick();
  await openFile("statement.pdf");
  await expect(page.getByRole("button", { name: "statement.pdf", exact: true })).toHaveCount(1);
  for (const label of ["Back to documents", "Open full view"]) await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  await expect(page.getByText("How should documents open?", { exact: true })).toHaveCount(0);
  await web.shot(join(artifacts, "file-tab-pdf.png"));
  passed("PDF opens in a real file tab, reopens without duplication, and adds no Documents navigation");

  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await expect(page.getByRole("link", { name: "Save original file", exact: true })).toBeVisible();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save original file", exact: true }).click();
  const download = await downloadReady;
  assert.deepEqual(await readFile(await download.path()), await readFile(join(workspace, "statement.pdf")));
  passed("Download original preserves the PDF bytes through the real plugin transport");

  await page.getByRole("button", { name: "Add note to page 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Keep this note when the file tab closes");
  await page.getByRole("button", { name: "statement.pdf", exact: true }).hover();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).locator("..").getByRole("button", { name: "Close", exact: true }).click();
  await openFile("statement.pdf");
  await expect(page.getByRole("textbox", { name: "Note text", exact: true })).toHaveValue("Keep this note when the file tab closes");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  passed("a review note being composed survives closing and reopening the actual host tab");

  await openFile("contract.docx");
  await expect(page.getByText("Unit", { exact: true })).toBeVisible();
  await web.shot(join(artifacts, "file-tab-word.png"));
  passed("Word renders inside its file tab");

  await openFile("invoices.xlsx");
  await expect(page.getByRole("button", { name: "Next rows", exact: true })).toBeVisible();
  await web.shot(join(artifacts, "file-tab-excel.png"));
  await openFile("deck.pptx");
  await expect(page.getByRole("button", { name: "Next slide", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Previous slide", exact: true })).toBeEnabled();
  await web.shot(join(artifacts, "file-tab-slides.png"));
  passed("Excel grids and PowerPoint slide navigation render inside real file tabs");

  await openFile("live.csv");
  const picker = page.getByRole("dialog");
  await expect(picker.getByRole("radio", { name: "Viewer \u2014 paseo-doc-viewer", exact: true })).toBeVisible();
  await picker.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  await picker.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByText("Before rewrite", { exact: true })).toBeVisible();
  await web.shot(join(artifacts, "file-tab-csv.png"));
  passed("Paseo's real panel picker offers Viewer and Source and opens the selected viewer");

  sendFakeAgentTurn(turn.agentId, [{ edit: { path: "live.csv", old: "Before rewrite,1", new: "After rewrite,2" } }], { name });
  await expect(page.getByText("After rewrite", { exact: true })).toBeVisible();
  await expect(page.getByText("Before rewrite", { exact: true })).toHaveCount(0);
  await rm(join(workspace, "live.csv"));
  await expect(page.getByText("File not found", { exact: true })).toBeVisible();
  await writeFile(join(workspace, "live.csv"), "Name,Value\nRestored file,3\n");
  await expect(page.getByText("Restored file", { exact: true })).toBeVisible();
  passed("an actual fake-agent rewrite refreshes the open tab; deletion and restoration recover");

  const openWith = async (label) => {
    await page.getByRole("button", { name: "live.csv", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open with…", exact: true }).hover();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  await openWith("Source \u2014 Paseo");
  await expect(page.getByRole("button", { name: "Find in document", exact: true })).toHaveCount(0);
  await expect(page.getByText("Restored file,3", { exact: true })).toBeVisible();
  await openWith("Always use for .csv");
  await page.getByRole("button", { name: "live.csv", exact: true }).hover();
  await page.getByRole("button", { name: "live.csv", exact: true }).locator("..").getByRole("button", { name: "Close", exact: true }).click();
  await openFile("live.csv");
  await expect(page.getByText("Restored file,3", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openWith("Viewer \u2014 paseo-doc-viewer");
  await expect(page.getByText("Restored file", { exact: true })).toBeVisible();
  await web.shot(join(artifacts, "open-with-viewer.png"));
  passed("Open with switches to Source, remembers its association on reopen, and switches back to Viewer");

  await expect.poll(() => pluginRows(agentTimeline(turn.agentId, { name }), "turn-docs").length).toBeGreaterThan(0);
  passed("the real turn-ended hook appends a changed-documents timeline card");

  await openFile("statement.pdf");
  await expect(pdfField).toBeVisible();
  const separators = await page.getByRole("separator").count();
  await page.getByRole("button", { name: "More actions", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /^Split pane right/ }).click();
  await expect(page.getByRole("separator")).toHaveCount(separators + 1);
  await web.shot(join(artifacts, "split-pane.png"));
  passed("Paseo splits the file pane and the reader adapts to its narrower width");

  phone = await PaseoWeb.launch({ url: daemon.url, viewport: { width: 390, height: 844 } });
  await phone.page.emulateMedia({ colorScheme: "dark" });
  await phone.openWorkspace(serverId, selected.workspaceId);
  await phone.page.getByText("Open report", { exact: true }).click();
  await expect(phone.page.getByRole("textbox", { name: "Page number of 3", exact: true })).toBeVisible();
  await expect(phone.page.getByRole("img", { name: "Page 1", exact: true })).toBeVisible();
  for (const label of ["Back to documents", "Open full view"]) await expect(phone.page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth), 390);
  await phone.shot(join(artifacts, "compact-file-view.png"));
  assert.deepEqual(phone.pluginErrors, []);
  assert.deepEqual(phone.errors, []);
  passed("a chat file link opens the compact file viewer at 390 px without duplicate navigation or horizontal overflow");

  assert.deepEqual(web.pluginErrors, []);
  assert.deepEqual(web.errors, []);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ paseo: daemon.paseoVersion, checks, consoleErrors: web.errors, pluginErrors: web.pluginErrors }, null, 2));
  console.log(`Host checks passed. Artifacts: ${artifacts}`);
} catch (error) {
  if (web) {
    await web.shot(join(artifacts, "failure.png")).catch(() => {});
    await writeFile(join(artifacts, "failure.txt"), await web.page.locator("body").ariaSnapshot().catch(() => "UI unavailable"));
    console.error("Browser errors:", web.errors, "Plugin errors:", web.pluginErrors);
  }
  console.error(`Artifacts: ${artifacts}`);
  throw error;
} finally {
  await phone?.close();
  await web?.close();
  await daemonDown({ name, log: console.log });
  await rm(workspace, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
}

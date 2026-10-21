import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { inspectionWorkbook } from "../fixtures/generators.ts";
// One directory per run: a shared one under node_modules let concurrent runs overwrite each other's bundle and fixtures.
const chosenDirectory = process.env.VIEWER_BROWSER_DIR;
const directory = chosenDirectory ? resolve(chosenDirectory) : await mkdtemp(join(tmpdir(), "viewer-browser-"));
await mkdir(directory, { recursive: true });
process.on("exit", (code) => {
  if (code !== 0) console.error(`Bundle, fixtures and screenshots kept in ${directory}`);
  else if (chosenDirectory) console.log(`Screenshots: ${directory}`);
  else rmSync(directory, { recursive: true, force: true });
});
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 3; index++) pdf.addPage().drawText(`Searchable statement page ${index + 1}`, { font, x: 40, y: 700 });
await writeFile(`${directory}/searchable.pdf`, await pdf.save());
const long = await PDFDocument.create();
const longPage = long.addPage([600, 1400]);
for (let line = 0; line < 80; line++) longPage.drawText(line === 76 ? "The needle is on this line" : `Filler line ${line + 1}`, { font: await long.embedFont(StandardFonts.Helvetica), x: 40, y: 1380 - line * 17, size: 11 });
await writeFile(`${directory}/long.pdf`, await long.save());
const report = await PDFDocument.create();
const reportFont = await report.embedFont(StandardFonts.HelveticaBold);
for (let index = 0; index < 60; index++) {
  const sheet = report.addPage([612, 792]);
  sheet.drawText(`Section ${index + 1}`, { font: reportFont, x: 60, y: 700, size: 48 });
  if (index === 41) sheet.drawRectangle({ x: 60, y: 200, width: 480, height: 400, color: rgb(0.2, 0.4, 0.9) });
}
await writeFile(`${directory}/report.pdf`, await report.save());
const stateDirectory = await mkdtemp(resolve(tmpdir(), "viewer-browser-state-"));
await writeFile(`${directory}/forecast.xlsx`, await inspectionWorkbook());
const base = { bundle: true, jsx: "automatic", logLevel: "silent" };
await build({ ...base, entryPoints: ["test/browser/app.tsx"], outfile: `${directory}/app.js`, platform: "browser", alias: {
  "react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client/react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client": resolve("test/browser/plugin-shim.ts"),
} });
await build({ ...base, entryPoints: ["test/browser/server.ts"], outfile: `${directory}/server.cjs`, platform: "node", format: "cjs", external: ["@getpaseo/plugin", "zod"] });
// server.cjs runs from outside the project, so its external packages resolve through NODE_PATH.
const server = spawn(process.execPath, [`${directory}/server.cjs`], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_PATH: resolve("node_modules"), VIEWER_BROWSER_DIR: directory, PASEO_DOC_VIEWER_STATE_DIR: stateDirectory } });
// Runs in the page: play() and the first advance share one deadline, so a play() that never settles fails.
const playUntilAdvanced = (element) => new Promise((resolve, reject) => {
  const finish = (settle, value) => { clearTimeout(timer); element.removeEventListener("timeupdate", advanced); element.pause(); settle(value); };
  const timer = setTimeout(() => finish(reject, new Error(`playback did not advance in 5 s: ${element.currentTime}`)), 5000);
  const advanced = () => {
    if (element.currentTime > 0) finish(resolve, { currentTime: element.currentTime, duration: element.duration, muted: element.muted, error: element.error?.message, tracks: element.captureStream().getAudioTracks().length });
  };
  element.addEventListener("timeupdate", advanced);
  element.play().then(advanced, (error) => finish(reject, error));
});
let browser;
let page;
let failureSaved = false;
// Bounded, and its own errors are only reported, so they never replace the failure being reported.
const saveFailure = async () => {
  if (!page || failureSaved) return;
  failureSaved = true;
  try { console.error((await page.locator("body").innerText({ timeout: 5000 })).slice(0, 1800)); } catch (error) { console.error(`Could not read the page: ${error.message}`); }
  try { await page.screenshot({ path: `${directory}/failure.png`, fullPage: true, timeout: 10_000 }); } catch (error) { console.error(`Could not screenshot the page: ${error.message}`); }
};
const cleanUp = async () => {
  clearTimeout(watchdog);
  await browser?.close();
  server.kill("SIGTERM");
  await rm(stateDirectory, { recursive: true, force: true });
};
const RUN_LIMIT_MS = 10 * 60_000;
const overLimit = `Browser checks did not finish in ${RUN_LIMIT_MS / 60_000} minutes`;
let timedOut = false;
// A hang fails like any other check: the page is saved and everything cleaned up before exiting, and
// closing the browser fails what the checks wait on. If that hangs too, the second timer ends the run.
const watchdog = setTimeout(async () => {
  timedOut = true;
  console.error(overLimit);
  setTimeout(() => process.exit(1), 60_000).unref();
  await saveFailure();
  await cleanUp();
  process.exit(1);
}, RUN_LIMIT_MS);
try {
  const output = await Promise.race([once(server.stdout, "data"), once(server, "exit").then(() => { throw new Error("Harness exited before listening"); })]);
  const { port, root } = JSON.parse(output[0].toString());
  const launch = { headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu", "--disable-software-rasterizer"] };
  browser = await chromium.launch(launch);
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
  const failures = [];
  // PDFs page with previous, a page number field and next.
  const pageField = (target) => target.getByRole("textbox", { name: /^Page number of \d+$/ });
  // Documents keeps a PDF opened from it on screen until Back, so return to the list when one is open.
  const showDocuments = async (target) => {
    await target.getByRole("button", { name: "Documents", exact: true }).click();
    const back = target.getByRole("button", { name: "Back to documents", exact: true });
    await expect(target.getByRole("textbox", { name: "Search documents", exact: true }).or(back)).toBeVisible();
    if (await back.count()) await back.click();
  };
  page.on("pageerror", (error) => { failures.push(error.message); console.error("Browser error:", error.message); });
  // For each RPC call the page made from index `from` on that matches, whether it has been answered.
  const rpcCallsFrom = (from, method, input = {}) => page.evaluate(({ from, method, input }) => {
    const matches = (value, expected) => Object.entries(expected).every(([key, want]) => (want !== null && typeof want === "object" ? matches(value?.[key], want) : value?.[key] === want));
    return window.__rpcCalls.slice(from).filter((call) => call.method === method && matches(call.input, input)).map((call) => call.settled);
  }, { from, method, input });
  const rpcCallCount = () => page.evaluate(() => window.__rpcCalls.length);
  // Waits until such calls were made and all are answered. A poll sent after a change has seen it, so the
  // screen then shows the change within a render; the long limit only bounds a call that never comes.
  const rpcAnswered = (from, method, input) => expect.poll(async () => {
    const calls = await rpcCallsFrom(from, method, input);
    return calls.length > 0 && calls.every(Boolean);
  }, { message: `${method} answered`, timeout: 30_000 }).toBe(true);
  // Lets a render the last answer caused reach the screen, before a check that it changed nothing there.
  const nextFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  // The viewer saves its position a second after the last change, and at once when it closes, so a
  // reopen after every save is answered reads the latest.
  const reopenViewer = async () => {
    await page.getByRole("button", { name: "Close viewer", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__rpcCalls.every((call) => call.method !== "viewer-state.write" || call.settled))).toBe(true);
    await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  };
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(pageField(page)).toHaveValue("2");
  await expect(page.getByText("/ 3", { exact: true })).toBeVisible();
  // Desktop keeps compact 28 px controls.
  expect((await page.getByRole("button", { name: "Next page", exact: true }).boundingBox()).height).toBe(28);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("1.5x", { exact: true })).toBeVisible();
  // A click on the content must leave PageDown scrolling it, not a focus wrapper.
  const pageImage = page.getByRole("img").first();
  await pageImage.click();
  const scroller = async () => pageImage.evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node.scrollTop;
    }
    return null;
  });
  const before = await scroller();
  expect(before).not.toBeNull();
  await page.keyboard.press("PageDown");
  await expect.poll(scroller).toBeGreaterThan(before);
  await reopenViewer();
  await expect(pageField(page)).toHaveValue("2");
  await expect(page.getByText("1.5x", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset reading position", exact: true }).click();
  await expect(pageField(page)).toHaveValue("1");
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("statement");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("3 matches", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 1: Searchable statement page 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  // A PDF match with page boxes stays on the rendered page and highlights it there.
  await expect(page.getByRole("button", { name: "Show page text", exact: true })).toBeVisible();
  await expect(pageField(page)).toHaveValue("1");
  await expect(page.getByLabel("Current match on page", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Match on page", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${directory}/pdf-find.png`, fullPage: true });
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).focus();
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("textbox", { name: "Find in document", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "Invoices", exact: true }).click();
  await reopenViewer();
  await expect(page.getByRole("button", { name: "Invoices", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("Northwind");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next match", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("Invoices!B2", { exact: true })).toBeVisible();
  // The jump keeps column A in view when the match fits in the first columns.
  await expect(page.getByText(/^Columns 1-/)).toBeVisible();
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  await page.getByRole("button", { name: "forecast.xlsx", exact: true }).click();
  await page.getByText("$165.00", { exact: true }).click();
  const inspector = page.getByLabel("Cell Summary!B8", { exact: true });
  await expect(inspector.getByText("=B7*1.1", { exact: true })).toBeVisible();
  await expect(inspector.getByText("165", { exact: true })).toBeVisible();
  await expect(inspector.getByText('"$"#,##0.00', { exact: true })).toBeVisible();
  await page.getByText("=SUM(D3:D10)", { exact: true }).click();
  await expect(page.getByLabel("Cell Summary!G3", { exact: true }).getByText("None saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-inspector.png`, fullPage: true });
  await page.getByRole("button", { name: "Close cell", exact: true }).click();
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await page.getByRole("button", { name: "Use row 2 as header", exact: true }).click();
  await expect(page.getByText("Record 1 of 8 (row 3)", { exact: true })).toBeVisible();
  await expect(page.getByText("Region · A", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Record row 3", { exact: true }).getByText("North", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next record", exact: true }).click();
  await expect(page.getByLabel("Record row 4", { exact: true }).getByText("South", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect Total", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D4", { exact: true }).getByText("=B4+C4", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-record.png`, fullPage: true });
  await page.getByRole("button", { name: "Show in grid", exact: true }).click();
  await expect(page.getByText("Rows 4-10 of 10", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check for issues", exact: true }).click();
  const issues = page.getByLabel("Sheet issues", { exact: true });
  await expect(issues.getByText("Inspected Summary rows 1-5. Paused at the row limit, before Summary row 6.", { exact: true })).toBeVisible();
  await expect(issues.getByText("1 error cell, 1 formula without a saved result", { exact: true })).toBeVisible();
  while (await issues.getByRole("button", { name: "Continue check", exact: true }).isVisible()) {
    await issues.getByRole("button", { name: "Continue check", exact: true }).click();
    await expect(issues.getByLabel("Loading")).toHaveCount(0);
  }
  await expect(issues.getByText("Inspected Summary rows 1-10, Wide rows 1-21.", { exact: true })).toBeVisible();
  await expect(issues.getByText("2 error cells, 3 formulas without a saved result", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Summary!D9: no saved result · =B9+C9", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D9", { exact: true }).getByText("None saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Rows 9-10 of 10", { exact: true })).toBeVisible();
  await expect(issues.getByText("Issue 4 of 5", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Next issue", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D10", { exact: true }).getByText("=B10+C10", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Show list", exact: true }).click();
  await expect(issues.getByRole("button", { name: "Summary!E7: #REF!", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-issues.png`, fullPage: true });
  // Records keeps the chosen header row for the session, also after the document is reopened.
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "forecast.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await expect(page.getByText(/^Record \d+ of 8 \(row \d+\)$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Use row 2 as header", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "long.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /^Page 1: / }).click();
  // Playwright scrolls the window to the match row before clicking; the viewer's own
  // scroll is what should bring the highlight into the visible scrollport.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByLabel("Current match on page", { exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: `${directory}/pdf-match.png`, fullPage: true });
  await reopenViewer();
  await expect(page.getByRole("button", { name: "Show page text", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "many.csv", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("needle");
  const sinceManySearch = await rpcCallCount();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  // The client asks for the next part as soon as one answers, so all answered means the search is done.
  await rpcAnswered(sinceManySearch, "doc.search", { path: "many.csv", query: "needle" });
  await expect(page.getByText("120 matches", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search more", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "contract.docx", exact: true }).click();
  await expect.poll(() => page.getByText("Unit", { exact: true }).evaluate((cell) => {
    let row = cell;
    while (getComputedStyle(row).display !== "flex" || getComputedStyle(row).flexDirection !== "row") row = row.parentElement;
    let card = row;
    while (getComputedStyle(card).overflow !== "auto") card = card.parentElement;
    const inside = card.getBoundingClientRect().width - 2; // the card's 1 px border, which the shim does not draw
    const cells = row.lastElementChild.getBoundingClientRect().right - row.firstElementChild.getBoundingClientRect().left;
    return { gap: Math.round(inside - cells), overflow: card.scrollWidth - card.clientWidth };
  })).toEqual({ gap: 0, overflow: 0 });
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("services");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next match", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("Reading from search match", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "broken.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await expect(page.getByRole("link", { name: "Save original file", exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save original file", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("broken.pdf");
  expect(await readFile(await download.path(), "utf8")).toBe("original unsupported file");
  await page.getByRole("button", { name: ".env", exact: true }).click();
  await expect(page.getByText(/Unsupported file type/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "tone.wav", exact: true }).click();
  await expect(page.locator("audio")).toBeVisible();
  const media = await page.locator("audio").evaluate(playUntilAdvanced);
  expect(media.currentTime).toBeGreaterThan(0);
  expect(media.duration).toBeCloseTo(1, 1); expect(media.muted).toBe(false); expect(media.error).toBeUndefined();
  await page.screenshot({ path: `${directory}/audio.png`, fullPage: true });
  await page.getByRole("button", { name: "audible.webm", exact: true }).click();
  await expect(page.locator("video")).toBeVisible();
  const video = await page.locator("video").evaluate(playUntilAdvanced);
  expect(video.currentTime).toBeGreaterThan(0); expect(video.muted).toBe(false); expect(video.tracks).toBe(1);
  // A slow media transfer shows feedback immediately and can be cancelled before its response arrives.
  // Its chunk is held until after the cancel or navigation; once the late answer is handled, the
  // transfer must have asked for nothing more and shown nothing.
  let holdingMedia = true;
  const heldMedia = [];
  const holdMedia = async (route) => {
    if (holdingMedia && route.request().postDataJSON().method === "media.chunk") heldMedia.push(route);
    else await route.continue().catch(() => {});
  };
  const releaseMedia = async (since) => {
    holdingMedia = false;
    for (const route of heldMedia.splice(0)) await route.continue().catch(() => {});
    await rpcAnswered(since, "media.chunk");
    expect(await rpcCallsFrom(since, "media.chunk")).toEqual([true]);
    await nextFrame();
    holdingMedia = true;
  };
  await page.route("**/rpc", holdMedia);
  let sinceMedia = await rpcCallCount();
  await page.getByRole("button", { name: "animated.webp", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Loading animation", exact: true })).toBeVisible();
  await expect.poll(() => heldMedia.length).toBe(1);
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load animation", exact: true })).toBeVisible();
  await releaseMedia(sinceMedia);
  await expect(page.getByRole("button", { name: "Load animation", exact: true })).toBeVisible();
  await expect(page.getByRole("img").first()).toBeVisible();
  sinceMedia = await rpcCallCount();
  await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Loading video", exact: true })).toBeVisible();
  await expect.poll(() => heldMedia.length).toBe(1);
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Load video/ })).toBeVisible();
  await releaseMedia(sinceMedia);
  await expect(page.locator("video")).toHaveCount(0);
  sinceMedia = await rpcCallCount();
  await page.getByRole("button", { name: /^Load video/ }).click();
  await expect(page.getByRole("progressbar", { name: "Loading video", exact: true })).toBeVisible();
  await expect.poll(() => heldMedia.length).toBe(1);
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await releaseMedia(sinceMedia);
  await expect(page.locator("video")).toHaveCount(0);
  await page.unroute("**/rpc", holdMedia);
  // Adversarial lifecycle checks: a late request must not populate a new query
  // or create a Save link after the user cancelled preparation. Each first request is held until
  // after the change or cancel, and the checks run once its late answer is handled.
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  const heldSearch = [];
  const holdSearch = async (route) => {
    if (heldSearch.length === 0 && route.request().postDataJSON().method === "doc.search") heldSearch.push(route);
    else await route.continue().catch(() => {});
  };
  await page.route("**/rpc", holdSearch);
  const sinceStaleSearch = await rpcCallCount();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("statement");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => heldSearch.length).toBe(1);
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("no such phrase");
  await heldSearch[0].continue();
  // The stale search stops at its late answer: it asks for no further part.
  await rpcAnswered(sinceStaleSearch, "doc.search", { query: "statement" });
  expect(await rpcCallsFrom(sinceStaleSearch, "doc.search", { query: "statement" })).toEqual([true]);
  await nextFrame();
  await expect(page.getByRole("button", { name: /^Page \d+:/ })).toHaveCount(0);
  await expect(page.getByText("3 matches", { exact: true })).toHaveCount(0);
  await page.unroute("**/rpc", holdSearch);
  await page.getByRole("button", { name: "broken.pdf", exact: true }).click();
  const heldChunk = [];
  const holdChunk = async (route) => {
    if (heldChunk.length === 0 && route.request().postDataJSON().method === "file.chunk") heldChunk.push(route);
    else await route.continue().catch(() => {});
  };
  await page.route("**/rpc", holdChunk);
  const sinceDownload = await rpcCallCount();
  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await expect(page.getByLabel("Preparing original file", { exact: true })).toBeVisible();
  await expect.poll(() => heldChunk.length).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await heldChunk[0].continue();
  await rpcAnswered(sinceDownload, "file.chunk");
  expect(await rpcCallsFrom(sinceDownload, "file.chunk")).toEqual([true]);
  await nextFrame();
  await expect(page.getByRole("link", { name: "Save original file", exact: true })).toHaveCount(0);
  await page.unroute("**/rpc", holdChunk);
  // A slow position read does not hold up reading: the viewer opens when its own wait for the read
  // ends. The reads are held until the reader has turned the page.
  let holdingReads = true;
  const heldReads = [];
  const holdReads = async (route) => {
    if (holdingReads && route.request().postDataJSON().method === "viewer-state.read") heldReads.push(route);
    else await route.continue().catch(() => {});
  };
  await page.route("**/rpc", holdReads);
  const sinceSlowRead = await rpcCallCount();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(pageField(page)).toHaveValue("2");
  holdingReads = false;
  for (const route of heldReads.splice(0)) await route.continue().catch(() => {});
  await rpcAnswered(sinceSlowRead, "viewer-state.read", { path: "statement.pdf" });
  await nextFrame();
  await expect(pageField(page)).toHaveValue("2");
  // After the read timed out, a late answer must not enable writes over unread history. Closing
  // saves a pending position at once, so a save the late answer had enabled would be sent there.
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(pageField(page)).toHaveValue("3");
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  expect(await rpcCallsFrom(sinceSlowRead, "viewer-state.write")).toEqual([]);
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await page.unroute("**/rpc", holdReads);
  const thumbnails = { requested: [], inFlight: 0, maxInFlight: 0 };
  const isThumbnail = (request) => request.url().endsWith("/rpc") && request.postDataJSON()?.method === "doc.thumbnail";
  page.on("request", (request) => { if (!isThumbnail(request)) return; thumbnails.requested.push(request.postDataJSON().input.index); thumbnails.maxInFlight = Math.max(thumbnails.maxInFlight, ++thumbnails.inFlight); });
  const settled = (request) => { if (isThumbnail(request)) thumbnails.inFlight--; };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  const slowThumbnails = async (route) => {
    if (route.request().postDataJSON().method === "doc.thumbnail") await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", slowThumbnails);
  await page.getByRole("button", { name: "report.pdf", exact: true }).click();
  const sinceReportMap = await rpcCallCount();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await expect(page.getByRole("img", { name: "Page 1 thumbnail", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Page 10 thumbnail", exact: true })).toBeVisible();
  // One thumbnail is the current page, for screen readers too.
  await expect(page.locator('[aria-current="page"]')).toHaveAttribute("aria-label", "Open page 1");
  // The loader asks for the next thumbnail as soon as one answers, so once all are answered it wants no more.
  await rpcAnswered(sinceReportMap, "doc.thumbnail", { path: "report.pdf" });
  await nextFrame();
  expect(thumbnails.maxInFlight).toBeLessThanOrEqual(2);
  expect(new Set(thumbnails.requested).size).toBeLessThan(30);
  expect(thumbnails.requested).not.toContain(59);
  await page.screenshot({ path: `${directory}/page-map.png`, fullPage: true });
  await page.getByLabel("Page thumbnails", { exact: true }).evaluate((element) => { element.parentElement.parentElement.scrollTop = 1e6; });
  await expect(page.getByRole("img", { name: "Page 60 thumbnail", exact: true })).toBeVisible();
  expect(thumbnails.maxInFlight).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Open page 42", exact: true }).click();
  await expect(pageField(page)).toHaveValue("42");
  await expect(page.getByRole("img", { name: "Page 42", exact: true })).toBeVisible();
  // A typed page number opens that page, and one past the end opens the last.
  await pageField(page).fill("61");
  await pageField(page).press("Enter");
  await expect(pageField(page)).toHaveValue("60");
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await pageField(page).fill("4");
  await page.getByRole("button", { name: "Previous page", exact: true }).evaluate((button) => button.click());
  await expect(page.getByRole("img", { name: "Page 59", exact: true })).toBeVisible();
  await expect(pageField(page)).toHaveValue("4");
  await pageField(page).fill("42");
  await pageField(page).press("Enter");
  await expect(pageField(page)).toHaveValue("42");
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await expect(page.locator('[aria-current="page"]')).toHaveAttribute("aria-label", "Open page 42");
  await page.getByRole("button", { name: "Pin page 42", exact: true }).click();
  await page.getByRole("textbox", { name: "Pin label", exact: true }).fill("Chart");
  await page.getByRole("button", { name: "Save pin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 42, pinned", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/page-pins.png`, fullPage: true });
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  await page.getByRole("button", { name: "Reset reading position", exact: true }).click();
  await expect(pageField(page)).toHaveValue("1");
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true }).click();
  await expect(pageField(page)).toHaveValue("42");
  // A rewrite keeps the pin but asks the user to check it; confirming takes the new revision.
  const rewritten = await PDFDocument.load(await readFile(`${directory}/report.pdf`));
  rewritten.removePage(0);
  await writeFile(`${root}/report.pdf`, await rewritten.save());
  const sinceReportRewrite = await rpcCallCount();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await rpcAnswered(sinceReportRewrite, "doc.open", { path: "report.pdf" });
  const changedPin = page.getByRole("button", { name: /^Open pin: Page 42, Chart, May need checking/ });
  await expect(changedPin).toBeVisible();
  await page.getByRole("button", { name: "Confirm pin on page 42", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove pin on page 42", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open pin:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  // Closing the map stops further thumbnail requests. Pages 1 and 2 are held unanswered until the map
  // is gone, so page 3 is still queued at unmount; their late answers must not send it.
  await page.unroute("**/rpc", slowThumbnails);
  const held = [];
  let holding = true;
  const holdThumbnails = async (route) => {
    if (holding && route.request().postDataJSON().method === "doc.thumbnail") held.push(route);
    else await route.continue().catch(() => {});
  };
  const thumbnailCalls = () => page.evaluate(() => window.__rpcCalls.filter((call) => call.method === "doc.thumbnail")
    .map((call) => ({ page: `${call.input.path} ${call.input.index + 1}`, settled: call.settled })));
  const callsBeforeMap = (await thumbnailCalls()).length;
  const callsSinceMap = async () => (await thumbnailCalls()).slice(callsBeforeMap);
  await page.route("**/rpc", holdThumbnails);
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  const statementPages = () => held.map((route) => route.request().postDataJSON().input).filter((input) => input.path === "statement.pdf").map((input) => input.index + 1).sort();
  await expect.poll(statementPages).toEqual([1, 2]);
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open page 3", exact: true })).toHaveCount(0);
  holding = false;
  for (const route of held) await route.continue();
  // Once every call is settled, any refill they caused is already listed.
  await expect.poll(async () => (await callsSinceMap()).every((call) => call.settled)).toBe(true);
  expect((await callsSinceMap()).map((call) => call.page).sort()).toEqual(["statement.pdf 1", "statement.pdf 2"]);
  await expect.poll(() => thumbnails.inFlight).toBe(0);
  await page.unroute("**/rpc", holdThumbnails);
  // Review marks follow explicit presses only, for the revision on screen.
  const reviews = [];
  const recordReview = (request) => { if (request.url().endsWith("/rpc") && request.postDataJSON()?.method === "viewer-state.review") reviews.push(request.postDataJSON().input); };
  page.on("request", recordReview);
  const touch = async (name, seconds) => { await writeFile(`${root}/${name}`, await readFile(`${root}/${name}`)); await utimes(`${root}/${name}`, seconds, seconds); };
  // An agent writes, then its turn ends, which rescans the workspace. Returns the call count to wait from.
  const agentWrote = async (write) => {
    await write();
    await page.request.get(`http://127.0.0.1:${port}/turn-ended`);
    return rpcCallCount();
  };
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  const sinceTurnedPage = await rpcCallCount();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  // The page turn is saved a second later; that save must not mark the document reviewed.
  await rpcAnswered(sinceTurnedPage, "viewer-state.write", { path: "statement.pdf" });
  await nextFrame();
  // One name in both states: whether the file is reviewed is the pressed state.
  const markReviewed = page.getByRole("button", { name: "Mark reviewed", exact: true });
  await expect(markReviewed).toHaveAttribute("aria-pressed", "false");
  expect(await rpcCallsFrom(sinceTurnedPage, "viewer-state.review")).toEqual([]);
  await markReviewed.click();
  await expect(markReviewed).toHaveAttribute("aria-pressed", "true");
  expect(reviews).toHaveLength(1);
  await showDocuments(page);
  // First-run tips sit at the top of Documents: Next steps through them, Skip hides them for good
  // (the server keeps that), and the Tips link under the list brings them back.
  await expect(page.getByLabel("Tip 1 of 4", { exact: true })).toBeVisible();
  await expect(page.getByText("Open documents", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show tips", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next tip", exact: true }).click();
  await expect(page.getByLabel("Tip 2 of 4", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/tips.png` });
  await page.getByRole("button", { name: "Skip tips", exact: true }).click();
  await expect(page.getByLabel(/^Tip \d of 4$/)).toHaveCount(0);
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await expect(page.getByRole("button", { name: /^statement\.pdf, PDF, .*, reviewed$/ })).toBeVisible();
  await expect(page.getByLabel(/^Tip \d of 4$/)).toHaveCount(0);
  await page.getByRole("button", { name: "Show tips", exact: true }).click();
  await expect(page.getByLabel("Tip 1 of 4", { exact: true })).toBeVisible();
  for (let step = 1; step < 4; step++) await page.getByRole("button", { name: "Next tip", exact: true }).click();
  await expect(page.getByLabel("Tip 4 of 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip tips", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Done with tips", exact: true }).click();
  await expect(page.getByLabel(/^Tip \d of 4$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show tips", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^statement\.pdf, PDF, .*, reviewed$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^long\.pdf, PDF, [^,]*$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Needs review/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^New, / })).toHaveCount(0);
  const sinceListRewrite = await agentWrote(() => touch("statement.pdf", Date.now() / 1000 + 60));
  await rpcAnswered(sinceListRewrite, "docs.recent");
  await expect(page.getByRole("button", { name: /^statement\.pdf, PDF, .*, changed since review$/ })).toBeVisible();
  // Needs review leads the filter row, so it is not scrolled off on a phone.
  await expect(page.getByRole("button", { name: /^(Needs review|All), / }).first()).toHaveAttribute("aria-label", "Needs review, 1 document");
  const chipIcon = (target, name, icon) => target.getByRole("button", { name, exact: typeof name === "string" }).locator(`[aria-hidden="true"] [data-icon="${icon}"]`);
  await expect(chipIcon(page, "Needs review, 1 document", "TriangleAlert")).toHaveCSS("color", "rgb(251, 191, 36)");
  await expect(page.getByRole("button", { name: /^All, / })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Needs review, 1 document", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Needs review, 1 document", exact: true }).click();
  await expect(page.getByRole("button", { name: "Needs review, 1 document", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /, changed / })).toHaveCount(1);
  await page.screenshot({ path: `${directory}/needs-review.png`, fullPage: true });
  await page.getByRole("button", { name: /^statement\.pdf, PDF, / }).click();
  // Documents keeps its list, hidden, under the reader, so text checks look at what is shown.
  const reviewPill = page.getByText("Changed since review", { exact: true }).filter({ visible: true });
  await expect(reviewPill).toBeVisible();
  // A rewrite the open viewer has not picked up yet must not be marked reviewed.
  await touch("statement.pdf", Date.now() / 1000 + 120);
  const sinceRewrite = await rpcCallCount();
  await markReviewed.click();
  await expect.poll(() => rpcCallsFrom(sinceRewrite, "viewer-state.review")).toEqual([true]);
  await expect(markReviewed).toHaveAttribute("aria-pressed", "false");
  await expect(reviewPill).toBeVisible();
  // The viewer shows the rewrite once a revision poll answers, one poll interval at most.
  await rpcAnswered(sinceRewrite, "doc.open", { path: "statement.pdf" });
  await markReviewed.click();
  await expect(markReviewed).toHaveAttribute("aria-pressed", "true");
  // Back finds the list as it was left, still filtered to Needs review, and refreshed at once.
  await page.getByRole("button", { name: "Back to documents", exact: true }).click();
  await expect(page.getByText("No files changed since review", { exact: true })).toBeVisible({ timeout: 2000 });
  await page.getByRole("button", { name: "Needs review, 0 documents", exact: true }).click();
  await expect(page.getByRole("button", { name: /^statement\.pdf, PDF, .*, reviewed$/ })).toBeVisible();
  page.off("request", recordReview);
  // A timer does not run while a window is away, so the times are read again when it gets focus or shows again.
  const reviewedRow = page.getByRole("button", { name: /^statement\.pdf, PDF, changed .*, reviewed$/ });
  await expect(reviewedRow).toHaveAttribute("aria-label", /, changed just now, /);
  const shiftClock = (hours) => page.evaluate((hours) => { window.__realNow ??= Date.now; Date.now = () => window.__realNow() + hours * 3_600_000; }, hours);
  await shiftClock(2.5);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(reviewedRow).toHaveAttribute("aria-label", /, changed 2 h ago, /);
  await shiftClock(4.5);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reviewedRow).toHaveAttribute("aria-label", /, changed 4 h ago, /);
  await shiftClock(0);
  // A search that only matches a file the viewer cannot open says so.
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("analysis");
  await expect(page.getByText("Not a supported file type", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Found analysis\.ipynb, but \.ipynb is not a supported type\./)).toBeVisible();
  await page.screenshot({ path: `${directory}/search-unsupported.png`, fullPage: true });
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("");
  // Review notes: collect notes on two pages, leave the document and come back, then edit,
  // preview, copy and send them, with a busy, a racing and a failing recipient keeping the draft.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await pageField(page).fill("1");
  await pageField(page).press("Enter");
  await expect(pageField(page)).toHaveValue("1");
  await page.getByRole("button", { name: "Add note to page 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Legend overlaps the axis");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (1)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Add note to page 2", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Move this table onto its own page");
  await expect(page.getByRole("checkbox", { name: "Attach page image", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("checkbox", { name: "Attach page image", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Attach page image", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${directory}/review-compose.png`, fullPage: true });
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (2)", exact: true })).toBeVisible();
  // A half-typed note survives leaving the document, as on a workspace switch, until it is cancelled.
  await expect(page.getByRole("textbox", { name: "Note text", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add note to page 2", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Half typed");
  await page.getByRole("button", { name: "deck.pptx", exact: true }).click();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note text", exact: true })).toHaveValue("Half typed");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "deck.pptx", exact: true }).click();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (2)", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note text", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "contract.docx", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (2)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review notes (2)", exact: true }).click();
  await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  await expect(page.getByText("Page image attached", { exact: true })).toHaveCount(1);
  const preview = page.getByLabel("Review message", { exact: true });
  await expect(preview).toContainText("- Page 1: Legend overlaps the axis");
  await expect(preview).toContainText("- Page 2: Move this table onto its own page [image 1]");
  await expect(page.getByText(/^1 page image \(/)).toBeVisible();
  await page.getByRole("button", { name: "Edit note on page 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit note text", exact: true }).fill("Legend overlaps the x axis");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview).toContainText("- Page 1: Legend overlaps the x axis");
  await page.getByRole("button", { name: "Copy review", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("- Page 1: Legend overlaps the x axis");
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(4);
  expect(await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(
    ["Docs agent, Idle", "Racing agent, Idle", "Broken agent, Idle", "Busy agent, Busy"]);
  await expect(page.getByRole("radio", { name: "Busy agent, Busy", exact: true })).toHaveAttribute("aria-disabled", "true");
  // The most recently active idle agent is preselected; the busy one is newer but cannot take the review.
  await expect(page.getByRole("button", { name: "Send review to Docs agent", exact: true })).toBeVisible();
  // When the preselected agent turns busy it stays selected, and the screen says why Send is off.
  await page.evaluate(() => window.__setAgentStatus("docs", "running"));
  const sinceBusy = await rpcCallCount();
  await rpcAnswered(sinceBusy, "agents.list");
  await expect(page.getByRole("radio", { name: "Docs agent, Busy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send review to Docs agent", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Docs agent is busy. Wait until it is idle, or copy the review.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__setAgentStatus("docs", "idle"));
  const sinceIdle = await rpcCallCount();
  await rpcAnswered(sinceIdle, "agents.list");
  await expect(page.getByRole("radio", { name: "Docs agent, Idle", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send review to Docs agent", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(/ is busy\. Wait until it is idle/)).toHaveCount(0);
  await page.getByRole("radio", { name: "Racing agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Racing agent", exact: true }).click();
  await expect(page.getByText("Racing agent is not ready (busy). Nothing was sent; the draft is kept.", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Broken agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Broken agent", exact: true }).click();
  await expect(page.getByText(/^Could not send the review: sendAgentMessage rejected/)).toBeVisible();
  await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__sentReviews.length)).toBe(0);
  await page.request.get(`http://127.0.0.1:${port}/touch/statement.pdf`);
  const sinceNoteRewrite = await rpcCallCount();
  await rpcAnswered(sinceNoteRewrite, "doc.open", { path: "statement.pdf" });
  await expect(page.getByText("Older revision: the file changed since this note", { exact: true })).toHaveCount(2);
  await expect(preview).toContainText("\"statement.pdf\", older version (modified ");
  await expect(page.getByRole("button", { name: "Attach page 1 image", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: `${directory}/review-screen.png`, fullPage: true });
  await page.getByRole("radio", { name: "Docs agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Docs agent", exact: true }).click();
  await expect(page.getByText("Review sent to Docs agent", { exact: true })).toBeVisible();
  const delivered = await page.evaluate(() => window.__sentReviews);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].id).toBe("docs");
  expect(delivered[0].options.activeTurnBehavior).toBe("steer");
  expect(delivered[0].options.images).toHaveLength(1);
  expect(delivered[0].text).toContain("\"statement.pdf\", older version");
  expect(delivered[0].text).toMatch(/\(modified \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC, [\d,]+ bytes\)/);
  await page.screenshot({ path: `${directory}/review-sent.png`, fullPage: true });
  await page.getByRole("button", { name: "Open agent", exact: true }).click();
  expect(await page.evaluate(() => window.__openedAgent)).toBe("docs");
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add note to page / })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Review notes/ })).toHaveCount(0);
  // Phone layout: every PDF toolbar control, including the review ones, fits inside 390 px on one line.
  // The browser runs single-process, so the same page switches to the phone viewport.
  // Zoom is remembered per layout class: the desktop zoom set here must not reach the phone.
  const beforeWideZoom = await rpcCallCount();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("1.5x", { exact: true })).toBeVisible();
  await rpcAnswered(beforeWideZoom, "viewer-state.write", { path: "statement.pdf", position: { zoom: 1.5 } });
  const phone = page;
  await phone.setViewportSize({ width: 390, height: 844 });
  // A file the agent wrote since Documents was last opened is new until reviewed. Reloading
  // starts a new app session, so this visit compares against the first one above.
  await agentWrote(() => writeFile(`${root}/fresh.csv`, "a,b\n1,2\n"));
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await showDocuments(phone);
  await expect(phone.getByRole("button", { name: /^fresh\.csv, CSV table, .*, new$/ })).toBeVisible();
  await expect(phone.getByRole("button", { name: /^statement\.pdf, PDF, .*, changed since review$/ })).toBeVisible();
  await expect(chipIcon(phone, "New, 1 document", "Sparkles")).toHaveCSS("color", "rgb(99, 102, 241)");
  const chipRow = phone.getByRole("button", { name: /^All, / }).locator("xpath=../..");
  expect(await chipRow.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
  expect(await phone.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await phone.screenshot({ path: `${directory}/phone-chips.png` });
  await phone.getByRole("button", { name: "New, 1 document", exact: true }).click();
  await expect(phone.getByRole("button", { name: /, changed / })).toHaveCount(1);
  await phone.screenshot({ path: `${directory}/documents-new.png` });
  // Opening a new file in the viewer clears its New label, until the file changes again.
  const openedMark = phone.waitForResponse((response) => response.url().endsWith("/rpc") && response.request().postData()?.includes('"viewer-state.opened"'));
  await phone.getByRole("button", { name: /^fresh\.csv, CSV table, .*, new$/ }).click();
  expect(await (await openedMark).json()).toEqual({ marked: true });
  // A CSV reads inside Documents too; Back keeps the New filter, so the opened file has left it.
  await expect(phone.locator("main").getByLabel("fresh.csv", { exact: true })).toBeVisible();
  await phone.getByRole("button", { name: "Back to documents", exact: true }).click();
  await expect(phone.getByText("No new files", { exact: true })).toBeVisible();
  await phone.getByRole("button", { name: "New, 0 documents", exact: true }).click();
  await expect(phone.getByRole("button", { name: /^fresh\.csv, CSV table, changed [^,]*$/ })).toBeVisible();
  await expect(phone.getByRole("button", { name: /^New, / })).toHaveCount(0);
  const sinceFreshRewrite = await agentWrote(() => writeFile(`${root}/fresh.csv`, "a,b\n1,2\n3,4\n"));
  await rpcAnswered(sinceFreshRewrite, "docs.recent");
  await expect(phone.getByRole("button", { name: /^fresh\.csv, CSV table, .*, new$/ })).toBeVisible();
  await expect(phone.getByRole("button", { name: "New, 1 document", exact: true })).toBeVisible();
  // Tips fit a phone: reopened from under the list, one card above the search box, 44 pt targets, no overflow.
  await phone.getByRole("button", { name: "Show tips", exact: true }).click();
  const tipBox = await phone.getByLabel("Tip 1 of 4", { exact: true }).boundingBox();
  expect(tipBox.x).toBeGreaterThanOrEqual(0);
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(390);
  expect(tipBox.y).toBeLessThan((await phone.getByRole("textbox", { name: "Search documents", exact: true }).boundingBox()).y);
  for (const name of ["Skip tips", "Next tip"]) {
    const box = await phone.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x + box.width, name).toBeLessThanOrEqual(390);
    expect(box.height, name).toBeGreaterThanOrEqual(40);
  }
  expect(await phone.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await phone.screenshot({ path: `${directory}/tips-phone.png` });
  await phone.getByRole("button", { name: "Skip tips", exact: true }).click();
  await expect(phone.getByLabel(/^Tip \d of 4$/)).toHaveCount(0);
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await phone.getByRole("button", { name: "report.pdf", exact: true }).click();
  // Download sits in the tools row: no row of its own above the toolbar.
  const findBox = await phone.getByRole("button", { name: "Find in document", exact: true }).boundingBox();
  const downloadBox = await phone.getByRole("button", { name: "Download original", exact: true }).boundingBox();
  expect(Math.abs(downloadBox.y - findBox.y)).toBeLessThan(2);
  // Phones show `< [n] / N >`, and Reset is left to Fit and the map.
  await expect(phone.getByRole("button", { name: /^Page \d+$/ })).toHaveCount(0);
  await expect(phone.getByRole("button", { name: "Reset reading position", exact: true })).toHaveCount(0);
  await phone.getByRole("button", { name: "Page map", exact: true }).click();
  await phone.getByLabel("Page thumbnails", { exact: true }).evaluate((element) => { element.parentElement.parentElement.scrollTop = 0; });
  await phone.getByRole("button", { name: "Open page 1", exact: true }).click();
  await expect(pageField(phone)).toHaveValue("1");
  await phone.getByRole("button", { name: "Add note to page 1", exact: true }).click();
  await phone.getByRole("textbox", { name: "Note text", exact: true }).fill("Fits on a phone");
  await phone.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Review notes (1)", exact: true })).toBeVisible();
  for (const name of ["Find in document", "Page map", "Add note to page 1", "Review notes (1)", "Mark reviewed", "Download original", "Previous page", "Next page", "Show page text", "Zoom out", "Zoom in"]) {
    const box = await phone.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(390);
    // 40 pt controls plus a 4 pt hit slop make 44 pt touch targets on phones.
    expect(box.height, name).toBeGreaterThanOrEqual(40);
  }
  const field = await pageField(phone).boundingBox();
  expect(field.x + field.width).toBeLessThanOrEqual(390);
  expect(field.height).toBeGreaterThanOrEqual(40);
  const counter = await phone.getByText(/^\/ \d+$/).boundingBox();
  expect(counter.height).toBeLessThan(20);
  expect(await phone.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await phone.screenshot({ path: `${directory}/phone-toolbar.png` });
  // Under an error the download stands alone, so it keeps its label on phones too.
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await phone.getByRole("button", { name: "broken.pdf", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Download original", exact: true })).toContainText("Download original");
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await phone.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(phone.getByText("Fit", { exact: true })).toBeVisible();
  const beforePhoneZoom = await rpcCallCount();
  await phone.getByRole("button", { name: "Zoom in", exact: true }).click();
  await phone.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(phone.getByText("2x", { exact: true })).toBeVisible();
  await rpcAnswered(beforePhoneZoom, "viewer-state.write", { path: "statement.pdf", position: { zoom: 2 } });
  await phone.setViewportSize({ width: 1100, height: 1000 });
  await phone.goto(`http://127.0.0.1:${port}/`);
  await expect(phone.getByText("1.5x", { exact: true })).toBeVisible();
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await expect(phone.getByText("2x", { exact: true })).toBeVisible();
  // JSON Lines eval results: named columns, full long value with copy, record JSON, invalid lines as issues, find.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("button", { name: "evals.jsonl", exact: true }).click();
  await expect(page.getByText("meta.model", { exact: true })).toBeVisible();
  await expect(page.getByText("Rows 1-4 of 4", { exact: true })).toBeVisible();
  await page.getByText(/^The answer is 4\. Step by step/).click();
  const jsonCell = page.getByLabel("Cell output, row 1", { exact: true });
  await expect(jsonCell.getByText("Shortened here. Show full value reads all of it.", { exact: true })).toBeVisible();
  await jsonCell.getByRole("button", { name: "Show full value", exact: true }).click();
  await expect(jsonCell.getByText(/END-OF-ANSWER$/)).toBeVisible();
  await expect(jsonCell.getByText(/^Full value · 6,\d{3} characters$/)).toBeVisible();
  await jsonCell.getByRole("button", { name: "Copy full value", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/END-OF-ANSWER$/);
  await page.screenshot({ path: `${directory}/jsonl-full-value.png`, fullPage: true });
  await page.getByText(/^1 item: \["math"\]$/).click();
  await expect(page.getByLabel("Cell tags, row 1", { exact: true }).getByText("List (JSON array)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close cell", exact: true }).click();
  await page.getByRole("button", { name: "Check for issues", exact: true }).click();
  const lineIssues = page.getByLabel("Sheet issues", { exact: true });
  await expect(lineIssues.getByText("1 invalid line", { exact: true })).toBeVisible();
  await lineIssues.getByRole("button", { name: /^Line 3: / }).click();
  await expect(page.getByLabel(/^Cell id, row 3$/).getByText(/^Not valid JSON: /)).toBeVisible();
  await page.getByRole("button", { name: "Close issues", exact: true }).click();
  await page.getByRole("button", { name: "Close cell", exact: true }).click();
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Use row \d+ as header$/ })).toHaveCount(0);
  // Records opens at the row the issue jump showed: the invalid line, with its error in the first field.
  await expect(page.getByText("Record 3 of 4 (row 3)", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Record row 3", { exact: true }).getByText(/^Invalid JSON: /)).toBeVisible();
  await page.getByRole("button", { name: "Previous record", exact: true }).click();
  await expect(page.getByLabel("Record row 2", { exact: true }).getByText("meta.latency_ms", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show record JSON", exact: true }).click();
  await expect(page.getByText(/"latency_ms": 340/)).toBeVisible();
  await page.screenshot({ path: `${directory}/jsonl-record.png`, fullPage: true });
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("model-b");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("2 matches", { exact: true })).toBeVisible();
  // Turn card: the Settings link opens the viewer's settings screen on desktop and phone, fits 390 px
  // without pushing the title to a second line, and a host that cannot open settings leaves a hint.
  const settingsLinkName = "Settings: show changed documents after each turn";
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await expect(page.getByRole("button", { name: settingsLinkName, exact: true })).toContainText("Settings");
  await page.getByRole("button", { name: settingsLinkName, exact: true }).click();
  expect(await page.evaluate(() => window.__openedSettings)).toEqual(["viewer"]);
  await page.screenshot({ path: `${directory}/turn-card.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  const phoneLink = page.getByRole("button", { name: settingsLinkName, exact: true });
  await expect(phoneLink).not.toContainText("Settings");
  const linkBox = await phoneLink.boundingBox();
  const titleBox = await page.getByText("6 documents changed while this turn ran", { exact: true }).boundingBox();
  expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(390);
  expect(titleBox.height).toBeLessThan(20);
  expect(Math.abs(linkBox.y + linkBox.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThan(3);
  for (const open of await page.getByRole("button", { name: /^Open / }).all()) expect((await open.boundingBox()).x + (await open.boundingBox()).width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await phoneLink.click();
  expect(await page.evaluate(() => window.__openedSettings)).toEqual(["viewer"]);
  await page.screenshot({ path: `${directory}/turn-card-phone.png` });
  await page.goto(`http://127.0.0.1:${port}/?compact&settingsFail`);
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await expect(page.getByText("Turn these cards off in Settings, Document viewer.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: settingsLinkName, exact: true }).click();
  await expect(page.getByText("Turn these cards off in Settings, Document viewer.", { exact: true })).toBeVisible();
  const shots = process.env.TURN_CARD_SHOTS ?? directory;
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/`);
  const sinceCard = await rpcCallCount();
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  const cardFrame = page.getByLabel("Turn card frame", { exact: true });
  // The card asks for the next thumbnail as soon as one answers, so once all are answered it wants no more.
  await rpcAnswered(sinceCard, "doc.thumbnail");
  await expect(cardFrame.locator("img")).toHaveCount(3);
  for (const image of await cardFrame.locator("img").all()) {
    await image.evaluate((element) => element.decode());
    expect(await image.boundingBox()).toMatchObject({ width: 40, height: 40 });
  }
  const pdfRow = /^Open reports\/quarterly-report-with-a-long-file-name\.pdf, PDF, /;
  await expect(page.getByRole("button", { name: /^Open reports\/quarterly-report-with-a-long-file-name\.pdf, PDF, new$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open finance\/forecast\.xlsx, .*, changed during this turn$/ })).toBeVisible();
  await cardFrame.screenshot({ path: `${shots}/harness-desktop-card-thumbnails.png` });
  await page.getByRole("button", { name: pdfRow }).click();
  await expect(page.getByText("Document 1 of 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous document", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("img").first()).toBeVisible();
  await page.screenshot({ path: `${shots}/harness-desktop-viewer-stepper.png` });
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open reports\/quarterly-report-with-a-long-file-name\.pdf, PDF, opened since this turn$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open animated\.webp, .*, opened since this turn$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open screenshots\/photo\.png, .*, new$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open finance\/forecast\.xlsx, .*, changed during this turn$/ })).toBeVisible();
  await cardFrame.screenshot({ path: `${shots}/harness-desktop-card-opened.png` });
  // A document is marked opened once it has loaded, so the stepper waits for each mark before moving on.
  const step = async (button, position) => {
    const since = await rpcCallCount();
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByText(`Document ${position} of 4`, { exact: true })).toBeVisible();
    await rpcAnswered(since, "viewer-state.opened", { path: await page.evaluate(() => window.__openedScreen.params.path) });
  };
  await page.getByRole("button", { name: pdfRow }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Find in document", exact: true })).toBeVisible();
  await step("Next document", 2);
  await expect(page.getByRole("textbox", { name: "Find in document", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toHaveCount(0);
  await step("Next document", 3);
  await step("Next document", 4);
  await expect(page.getByRole("button", { name: "Next document", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Previous document", exact: true }).click();
  await expect(page.getByText("Document 3 of 4", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__openedScreen.params)).toMatchObject({ path: "screenshots/photo.png" });
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await expect(page.getByLabel("Opened", { exact: true })).toHaveCount(4);
  await page.getByRole("button", { name: "report.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: "Find in document", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next document", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  const sincePhoneCard = await rpcCallCount();
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await rpcAnswered(sincePhoneCard, "doc.thumbnail");
  await expect(cardFrame.locator("img")).toHaveCount(3);
  for (const image of await cardFrame.locator("img").all()) {
    await image.evaluate((element) => element.decode());
    expect(await image.boundingBox()).toMatchObject({ width: 36, height: 36 });
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await cardFrame.screenshot({ path: `${shots}/harness-phone-card-opened.png` });
  await page.getByRole("button", { name: pdfRow }).click();
  await expect(page.getByText("Document 1 of 4", { exact: true })).toBeVisible();
  // The stepper shows while the document loads too; More comes with the loaded toolbar.
  await expect(page.getByRole("button", { name: "More actions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toHaveCount(0);
  const stepperBox = await page.getByRole("button", { name: "Next document", exact: true }).boundingBox();
  const toolbarBox = await page.getByRole("button", { name: "More actions", exact: true }).boundingBox();
  expect(Math.abs(stepperBox.y - toolbarBox.y)).toBeLessThan(4);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/harness-phone-viewer-more.png` });
  for (const name of ["Previous document", "Next document", "Find in document", "More actions", "Page map", "Mark reviewed", "Download original"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x + box.width, name).toBeLessThanOrEqual(390);
    expect(box.height, name).toBeGreaterThanOrEqual(40);
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "Next document", exact: true }).click();
  await expect(page.getByText("Document 2 of 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find in document", exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/harness-phone-viewer-stepper.png` });
  const collapseShots = process.env.TURN_CARD_COLLAPSE_SHOTS ?? directory;
  await mkdir(collapseShots, { recursive: true });
  const checkoutName = "paseo-doc-viewer-gallery, new Git checkout, 65 documents";
  const exportsName = "exports, new folder, 13 documents";
  // The name stays the same whether the row is open; aria-expanded and the visible Show or Hide carry that.
  const folderToggle = (name) => page.getByRole("button", { name: `Show or hide ${name}`, exact: true });
  const cardThumbnailPaths = [];
  const recordCardThumbnail = (request) => { if (isThumbnail(request)) cardThumbnailPaths.push(request.postDataJSON().input.path); };
  page.on("request", recordCardThumbnail);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/`);
  const sinceCheckoutCard = await rpcCallCount();
  await page.getByRole("button", { name: "Checkout card", exact: true }).click();
  await expect(page.getByText("80 documents changed while this turn ran", { exact: true })).toBeVisible();
  await expect(page.getByText("New checkout · 65 documents", { exact: true })).toBeVisible();
  await expect(page.getByText("New folder · 13 documents", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(2);
  // The card asks for the next thumbnail as soon as one answers, so once all are answered it wants no more.
  await rpcAnswered(sinceCheckoutCard, "doc.thumbnail");
  await nextFrame();
  await expect(cardFrame.locator("img")).toHaveCount(1);
  expect(cardThumbnailPaths.filter((path) => path.startsWith("paseo-doc-viewer-gallery/"))).toEqual([]);
  await cardFrame.screenshot({ path: `${collapseShots}/harness-desktop-collapsed.png` });
  await page.getByRole("button", { name: /^Open finance\/forecast\.xlsx, / }).click();
  await expect(page.getByText("Document 2 of 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Checkout card", exact: true }).click();
  await expect(folderToggle(checkoutName)).toHaveAttribute("aria-expanded", "false");
  await expect(folderToggle(checkoutName).getByText("Show", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open finance\/forecast\.xlsx, / })).not.toHaveAttribute("aria-expanded");
  const sinceShow = await rpcCallCount();
  await folderToggle(checkoutName).click();
  await expect(folderToggle(checkoutName)).toHaveAttribute("aria-expanded", "true");
  await expect(folderToggle(checkoutName).getByText("Hide", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(14);
  await rpcAnswered(sinceShow, "doc.thumbnail");
  await expect(cardFrame.locator("img")).toHaveCount(13);
  for (const image of await cardFrame.locator("img").all()) await image.evaluate((element) => element.decode());
  await expect(page.getByRole("button", { name: "+53 more in Documents", exact: true })).toBeVisible();
  await cardFrame.screenshot({ path: `${collapseShots}/harness-desktop-expanded.png` });
  await page.getByRole("button", { name: /^Open paseo-doc-viewer-gallery\/assets\/shot-2\.png, / }).click();
  await expect(page.getByText("Document 5 of 14", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous document", exact: true }).click();
  await expect(page.getByText("Document 4 of 14", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__openedScreen.params)).toMatchObject({ path: "paseo-doc-viewer-gallery/assets/shot-1.png" });
  await page.getByRole("button", { name: "Checkout card", exact: true }).click();
  await folderToggle(checkoutName).click();
  await folderToggle(checkoutName).click();
  await expect(folderToggle(checkoutName)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(2);
  page.off("request", recordCardThumbnail);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await page.getByRole("button", { name: "Checkout card", exact: true }).click();
  await expect(page.getByText("New checkout · 65 documents", { exact: true })).toBeVisible();
  for (const button of await cardFrame.getByRole("button").all()) expect((await button.boundingBox()).x + (await button.boundingBox()).width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await cardFrame.screenshot({ path: `${collapseShots}/harness-phone-collapsed.png` });
  await folderToggle(checkoutName).click();
  await folderToggle(exportsName).click();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(26);
  await expect(page.getByRole("button", { name: "+1 more in Documents", exact: true })).toBeVisible();
  for (const button of await cardFrame.getByRole("button").all()) expect((await button.boundingBox()).x + (await button.boundingBox()).width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "+1 more in Documents", exact: true }).click();
  expect(await page.evaluate(() => window.__openedPanel)).toEqual({ id: "documents", workspaceId: "workspace" });
  await cardFrame.screenshot({ path: `${collapseShots}/harness-phone-expanded.png` });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  const rowIcon = (row, name) => page.getByRole("button", { name: row }).locator(`[data-icon="${name}"]`);
  await expect(rowIcon(/^report\.pdf, PDF, /, "FileText")).toHaveCSS("color", "rgb(234, 152, 147)");
  await expect(rowIcon(/^invoices\.xlsx, Spreadsheet, /, "FileSpreadsheet")).toHaveCSS("color", "rgb(143, 249, 156)");
  await expect(chipIcon(page, /^PDF, \d+ documents$/, "FileText")).toHaveCSS("color", "rgb(234, 152, 147)");
  await expect(chipIcon(page, /^Spreadsheets and data, \d+ documents$/, "FileSpreadsheet")).toHaveCSS("color", "rgb(143, 249, 156)");
  await expect(chipIcon(page, /^All, \d+ documents$/, "Files")).toHaveCSS("color", "rgb(156, 163, 175)");
  await page.screenshot({ path: `${shots}/harness-chips.png` });
  await page.getByRole("button", { name: "Turn card", exact: true }).click();
  await expect(cardFrame.locator('[data-icon="FileSpreadsheet"]')).toHaveCSS("color", "rgb(143, 249, 156)");
  await page.getByRole("button", { name: "Checkout card", exact: true }).click();
  await folderToggle(exportsName).click();
  await expect(cardFrame.locator('[data-icon="FileSpreadsheet"]')).toHaveCount(13);
  for (const icon of await cardFrame.locator('[data-icon="FileSpreadsheet"]').all()) await expect(icon).toHaveCSS("color", "rgb(143, 249, 156)");
  await expect(cardFrame.locator('[data-icon="Folder"]').first()).toHaveCSS("color", "rgb(156, 163, 175)");
  await fetch(`http://127.0.0.1:${port}/settings?kindColors=0`);
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await expect(rowIcon(/^report\.pdf, PDF, /, "FileText")).toHaveCSS("color", "rgb(156, 163, 175)");
  await expect(chipIcon(page, /^PDF, \d+ documents$/, "FileText")).toHaveCSS("color", "rgb(156, 163, 175)");
  await page.screenshot({ path: `${shots}/harness-chips-colors-off.png` });
  await fetch(`http://127.0.0.1:${port}/settings?kindColors=1`);
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  const viewButton = (name) => page.getByRole("button", { name, exact: true });
  await expect(viewButton("List view")).toHaveAttribute("aria-pressed", "true");
  await expect(viewButton("Details view")).toHaveAttribute("aria-pressed", "false");
  const pdfHeader = page.getByRole("button", { name: /^PDF, \d+( of \d+)?$/ });
  await expect(pdfHeader).toHaveAttribute("aria-expanded", "true");
  await pdfHeader.click();
  await expect(pdfHeader).toHaveAttribute("aria-expanded", "false");
  await pdfHeader.click();
  await expect(viewButton("Details view")).toContainText("Details");
  const searchBox = await page.getByRole("textbox", { name: "Search documents", exact: true }).boundingBox();
  const switchBox = await viewButton("Previews view").boundingBox();
  expect(Math.abs(switchBox.y + switchBox.height / 2 - (searchBox.y + searchBox.height / 2))).toBeLessThanOrEqual(1);
  expect(switchBox.x).toBeGreaterThan(searchBox.x + searchBox.width);
  await viewButton("Details view").click();
  await expect(viewButton("Details view")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("FOLDER", { exact: true })).toBeVisible();
  const detailsRow = page.getByRole("button", { name: /^quarterly-report-with-a-long-file-name\.pdf, PDF, in reports, changed [^,]*, [\d.]+ KB/ });
  expect((await detailsRow.boundingBox()).height).toBeLessThanOrEqual(30);
  await expect(detailsRow.getByText("reports", { exact: true })).toBeVisible();
  await expect(detailsRow.getByText(/^\d\d:\d\d$/)).toBeVisible();
  // Column titles line up with the cells, and screen readers skip them.
  const edges = async (locator) => { const box = await locator.boundingBox(); return [box.x, box.x + box.width]; };
  const lined = async (title, cell, edge) => expect(Math.abs((await edges(page.getByText(title, { exact: true })))[edge] - (await edges(detailsRow.getByText(cell, { exact: true })))[edge])).toBeLessThanOrEqual(1);
  await lined("NAME", "quarterly-report-with-a-long-file-name.pdf", 0);
  await lined("FOLDER", "reports", 0);
  await lined("SIZE", /^[\d.]+ KB$/, 1);
  await expect(page.locator('[aria-hidden="true"]').filter({ hasText: "FOLDER" })).toHaveCount(1);
  // Where scrollbars take room from the list (Windows, Linux, or macOS set to always show them; 8 px here), the
  // titles sit in the list, so they still line up and stay put while it scrolls.
  const scrollbars = await chromium.launch({ ...launch, ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    const scrolled = await scrollbars.newPage({ viewport: { width: 1100, height: 1000 } });
    await scrolled.goto(`http://127.0.0.1:${port}`);
    await scrolled.addStyleTag({ content: "::-webkit-scrollbar { width: 8px } ::-webkit-scrollbar-thumb { background: #888 }" });
    await scrolled.getByRole("button", { name: "Documents", exact: true }).click();
    const sizeTitle = scrolled.getByText("SIZE", { exact: true });
    await expect(sizeTitle).toBeVisible();
    expect(await scrolled.evaluate(() => [...document.querySelectorAll("main div")].some((node) => node.scrollHeight > node.clientHeight && node.offsetWidth - node.clientWidth === 8))).toBe(true);
    const sizeCell = scrolled.getByRole("button", { name: /^quarterly-report-with-a-long-file-name\.pdf, / }).getByText(/^[\d.]+ KB$/);
    expect(Math.abs((await edges(sizeTitle))[1] - (await edges(sizeCell))[1])).toBeLessThanOrEqual(1);
    const titleTop = (await sizeTitle.boundingBox()).y;
    await scrolled.mouse.move(500, 600);
    await scrolled.mouse.wheel(0, 400);
    await expect.poll(() => scrolled.evaluate(() => Math.max(...[...document.querySelectorAll("main div")].map((node) => node.scrollTop)))).toBeGreaterThan(0);
    expect(Math.abs((await sizeTitle.boundingBox()).y - titleTop)).toBeLessThanOrEqual(1);
    await scrolled.screenshot({ path: `${shots}/harness-details-scrolled.png` });
  } finally {
    await scrollbars.close();
  }
  await page.screenshot({ path: `${shots}/harness-details.png` });
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("invoices");
  await expect(page.getByRole("button", { name: /, changed / })).toHaveCount(1);
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await expect(viewButton("Details view")).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await showDocuments(page);
  await expect(viewButton("List view")).toHaveAttribute("aria-pressed", "true");
  await viewButton("Details view").click();
  await expect(page.getByText("NAME", { exact: true })).toBeVisible();
  await expect(page.getByText("FOLDER", { exact: true })).toHaveCount(0);
  await expect(page.getByText("SIZE", { exact: true })).toHaveCount(0);
  const phoneDetailsRow = page.getByRole("button", { name: /^quarterly-report-with-a-long-file-name\.pdf, PDF, / });
  await expect(phoneDetailsRow).toBeVisible();
  expect((await phoneDetailsRow.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.screenshot({ path: `${shots}/harness-phone-details.png` });
  await viewButton("List view").click();
  for (const option of ["List view", "Details view", "Previews view"]) {
    await expect(viewButton(option)).not.toContainText(/List|Details|Previews/);
    expect((await viewButton(option).boundingBox()).height).toBeGreaterThanOrEqual(40);
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  // The answer to the List press is held until after Preview is pressed; it must not switch the view back.
  let heldWrite;
  const holdListWrite = async (route) => {
    const body = route.request().postDataJSON();
    if (!heldWrite && body.method === "documents-view.write" && body.input.view === "list") heldWrite = route;
    else await route.continue().catch(() => {});
  };
  await page.route("**/rpc", holdListWrite);
  await viewButton("List view").click();
  await expect.poll(() => Boolean(heldWrite)).toBe(true);
  const previewsFrom = await rpcCallCount();
  await viewButton("Previews view").click();
  await expect(viewButton("Previews view")).toHaveAttribute("aria-pressed", "true");
  await heldWrite.continue();
  await expect.poll(() => page.evaluate(() => window.__rpcCalls.filter((call) => call.method === "documents-view.write").slice(-2).map((call) => `${call.input.view} ${call.settled}`)))
    .toEqual(["list true", "previews true"]);
  await page.unroute("**/rpc", holdListWrite);
  await expect(viewButton("Previews view")).toHaveAttribute("aria-pressed", "true");
  const reportTile = page.getByRole("button", { name: /^report\.pdf, PDF, .*, \d+ pages?$/ });
  // A tile's picture is drawn once its thumbnail call is answered, and a busy answer is asked again later.
  await rpcAnswered(previewsFrom, "doc.thumbnail", { path: "report.pdf" });
  await expect(reportTile.locator("img")).toBeVisible();
  await expect(reportTile.getByText(/ · \d+ pages?$/)).toBeVisible();
  await expect(reportTile.locator('[data-icon="FileText"]')).toHaveCSS("color", "rgb(234, 152, 147)");
  const tileBox = await reportTile.boundingBox();
  expect(tileBox.width).toBeLessThanOrEqual(180);
  expect(tileBox.width).toBeGreaterThanOrEqual(120);
  const longTile = await page.getByRole("button", { name: /^long\.pdf, PDF, / }).boundingBox();
  expect(Math.abs(longTile.y - tileBox.y) < 1 || Math.abs(longTile.x - tileBox.x) < 1).toBe(true);
  await rpcAnswered(previewsFrom, "doc.thumbnail", { path: "screenshots/photo.png" });
  await expect(page.getByRole("button", { name: /^photo\.png, Image, / }).locator("img")).toBeVisible();
  const deckTile = page.getByRole("button", { name: /^deck\.pptx, Presentation, .*, 11 slides$/ });
  await rpcAnswered(previewsFrom, "doc.thumbnail", { path: "deck.pptx" });
  await expect(deckTile.getByText("Slide 1", { exact: true })).toBeVisible();
  await expect(deckTile.getByText(/ · 11 slides$/)).toBeVisible();
  const wordRow = page.getByRole("button", { name: /^contract\.docx, / });
  expect((await wordRow.boundingBox()).width).toBeGreaterThan(600);
  await expect(wordRow.locator("img")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/harness-previews.png`, fullPage: true });
  // Typing narrows and widens the tiles; each file and revision is still asked for once, a failed one too.
  const thumbnailsSettled = () => page.evaluate(() => window.__rpcCalls.every((call) => call.method !== "doc.thumbnail" || call.settled));
  await expect.poll(thumbnailsSettled).toBe(true);
  for (const query of ["p", "pd", "pdf", "pd", "p", ""]) {
    await page.getByRole("textbox", { name: "Search documents", exact: true }).fill(query);
    await nextFrame();
  }
  await expect.poll(thumbnailsSettled).toBe(true);
  const previewCalls = await page.evaluate((from) => window.__rpcCalls.slice(from).filter((call) => call.method === "doc.thumbnail").map((call) => `${call.input.path} ${call.input.revision} ${call.input.width}`), previewsFrom);
  expect(previewCalls.length).toBeGreaterThan(3);
  expect(previewCalls.length).toBe(new Set(previewCalls).size);
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("report");
  await expect(page.getByRole("button", { name: /, changed / })).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("");
  await page.goto(`http://127.0.0.1:${port}/?width=230`);
  await showDocuments(page);
  await expect(viewButton("Previews view")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^report\.pdf, PDF, / })).toBeVisible();
  await expect(page.getByRole("button", { name: /^report\.pdf, PDF, / }).locator("img")).toHaveCount(0);
  await expect(chipIcon(page, /^PDF, \d+ documents$/, "FileText")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(230);
  await page.screenshot({ path: `${shots}/harness-sidebar-previews.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await showDocuments(page);
  const sincePhonePreviews = await rpcCallCount();
  await viewButton("Previews view").click();
  await rpcAnswered(sincePhonePreviews, "doc.thumbnail", { path: "report.pdf" });
  await expect(page.getByRole("button", { name: /^report\.pdf, PDF, / }).locator("img")).toBeVisible();
  const phoneTiles = await Promise.all(["report", "long"].map((name) => page.getByRole("button", { name: new RegExp(`^${name}\\.pdf, PDF, `) }).boundingBox()));
  expect(phoneTiles[0].width).toBeGreaterThan(150);
  expect(phoneTiles[0].width * 2).toBeLessThan(390);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.screenshot({ path: `${shots}/harness-phone-previews.png`, fullPage: true });
  await viewButton("List view").click();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await viewButton("List view").click();
  await viewButton("Tree view").click();
  await expect(viewButton("Tree view")).toHaveAttribute("aria-pressed", "true");
  const folderRow = (name) => page.getByRole("treeitem", { name: new RegExp(`^${name}, folder(?: in [^,]+)?, \\d+ documents?$`) });
  const fileRow = (name) => page.getByRole("treeitem", { name: new RegExp(`^${name.replace(".", "\\.")}, `) });
  // On the web the rows are the items of a tree, each with its level.
  await expect(page.getByRole("tree", { name: "Documents by folder", exact: true })).toBeVisible();
  await expect(folderRow("archive/2025/q4")).toHaveAttribute("aria-label", "archive/2025/q4, folder, 1 document");
  await expect(folderRow("archive/2025/q4")).toHaveAttribute("aria-expanded", "true");
  await expect(folderRow("archive/2025/q4")).toHaveAttribute("aria-level", "1");
  await expect(fileRow("ledger.pdf")).toBeVisible();
  await expect(fileRow("ledger.pdf")).toHaveAttribute("aria-level", "2");
  await expect(folderRow("exports")).toHaveAttribute("aria-label", "exports, folder, 12 documents");
  await expect(folderRow("paseo-doc-viewer-gallery")).toHaveAttribute("aria-label", "paseo-doc-viewer-gallery, folder, 12 documents");
  await expect(folderRow("docs")).toHaveAttribute("aria-expanded", "false");
  await expect(folderRow("docs")).toHaveAttribute("aria-label", "docs, folder in paseo-doc-viewer-gallery, 1 document");
  await expect(fileRow("guide.pdf")).toHaveCount(0);
  // Space presses a row like Enter does. The host presses on Space only for role="button", so the rows handle it.
  await folderRow("docs").focus();
  await page.keyboard.press("Space");
  await expect(folderRow("docs")).toHaveAttribute("aria-expanded", "true");
  await expect(fileRow("guide.pdf")).toBeVisible();
  await expect(fileRow("guide.pdf")).toHaveAttribute("aria-level", "3");
  await page.keyboard.press("Space");
  await expect(folderRow("docs")).toHaveAttribute("aria-expanded", "false");
  await expect(fileRow("guide.pdf")).toHaveCount(0);
  expect((await folderRow("screenshots").boundingBox()).y).toBeLessThan((await fileRow("animated.webp").boundingBox()).y);
  expect((await fileRow("animated.webp").boundingBox()).y).toBeLessThan((await fileRow("statement.pdf").boundingBox()).y);
  await expect(fileRow("statement.pdf").getByText(/^(Reviewed|Changed since review)$/)).toBeVisible();
  await expect(fileRow("statement.pdf").getByText(/^[\d.]+ KB · /)).toBeVisible();
  expect((await fileRow("statement.pdf").boundingBox()).height).toBeLessThanOrEqual(30);
  await folderRow("docs").click();
  await expect(fileRow("guide.pdf")).toBeVisible();
  const docsChevron = await folderRow("docs").locator('[data-icon="ChevronDown"]').boundingBox();
  expect((await fileRow("guide.pdf").locator('[data-icon="FileText"]').boundingBox()).x - docsChevron.x).toBe(16);
  await page.screenshot({ path: `${shots}/harness-tree.png` });
  await folderRow("paseo-doc-viewer-gallery").click();
  await expect(folderRow("paseo-doc-viewer-gallery")).toHaveAttribute("aria-expanded", "false");
  await expect(fileRow("guide.pdf")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all folders", exact: true }).click();
  await expect(fileRow("guide.pdf")).toBeVisible();
  await expect(fileRow("shot-11.png")).toBeVisible();
  await page.getByRole("button", { name: "Collapse all folders", exact: true }).click();
  await expect(fileRow("ledger.pdf")).toHaveCount(0);
  await expect(fileRow("run-1.csv")).toHaveCount(0);
  await expect(fileRow("statement.pdf")).toBeVisible();
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("guide");
  await expect(folderRow("paseo-doc-viewer-gallery/docs")).toHaveAttribute("aria-label", "paseo-doc-viewer-gallery/docs, folder, 1 document");
  await expect(fileRow("guide.pdf")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /, changed / })).toHaveCount(1);
  await page.screenshot({ path: `${shots}/harness-tree-search.png` });
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("");
  await expect(fileRow("guide.pdf")).toHaveCount(0);
  await expect(folderRow("exports")).toHaveAttribute("aria-expanded", "false");
  await folderRow("exports").click();
  await fileRow("run-2.csv").click();
  const runs = Array.from({ length: 12 }, (_, index) => `exports/run-${index + 1}.csv`);
  await expect(page.getByText("Document 2 of 12", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next document", exact: true }).click();
  await expect(page.getByText("Document 3 of 12", { exact: true })).toBeVisible();
  // Open in tab hands the document and its folder to the standalone screen.
  expect(await page.evaluate(() => window.__openedScreen)).toBeUndefined();
  await page.getByRole("button", { name: "Open in tab", exact: true }).click();
  const tabbed = await page.evaluate(() => window.__openedScreen);
  expect(tabbed).toMatchObject({ screenId: "document", params: { workspaceId: "workspace", path: "exports/run-3.csv" } });
  expect(JSON.parse(tabbed.params.siblings)).toEqual(runs);
  await expect(page.getByText("Document 3 of 12", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to documents", exact: true })).toHaveCount(0);
  await showDocuments(page);
  await fileRow("run-2.csv").focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Document 2 of 12", { exact: true })).toBeVisible();
  await showDocuments(page);
  await expect(fileRow("run-2.csv")).toBeVisible();
  await expect(fileRow("ledger.pdf")).toHaveCount(0);
  // A PDF opened from Tree reads inside Documents, and Previous and Next step its folder there.
  const screenBefore = await page.evaluate(() => window.__openedScreen?.params?.path);
  await fileRow("report.pdf").click();
  const back = page.getByRole("button", { name: "Back to documents", exact: true });
  await expect(back).toBeVisible();
  await expect(page.locator("main").getByLabel("report.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Document \d+ of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Next document", exact: true }).click();
  await expect(page.locator("main").getByLabel("statement.pdf", { exact: true })).toBeVisible();
  await expect(back).toBeVisible();
  expect(await page.evaluate(() => window.__openedScreen?.params?.path)).toBe(screenBefore);
  await back.click();
  await expect(fileRow("report.pdf")).toBeVisible();
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await expect(viewButton("Tree view")).toHaveAttribute("aria-pressed", "true");
  await page.goto(`http://127.0.0.1:${port}/?width=230`);
  await showDocuments(page);
  await expect(viewButton("Tree view")).toHaveAttribute("aria-pressed", "true");
  const narrowSearch = await page.getByRole("textbox", { name: "Search documents", exact: true }).boundingBox();
  const narrowSwitch = await viewButton("Tree view").boundingBox();
  expect(narrowSwitch.y).toBeGreaterThan(narrowSearch.y + narrowSearch.height);
  expect(narrowSwitch.x + narrowSwitch.width).toBeLessThanOrEqual(230);
  expect(narrowSearch.width).toBeGreaterThan(150);
  await expect(page.getByRole("textbox", { name: "Search documents", exact: true })).toHaveAttribute("placeholder", "Search documents");
  await expect(fileRow("statement.pdf")).toBeVisible();
  await expect(fileRow("statement.pdf").getByText(/ KB · /)).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(230);
  await page.screenshot({ path: `${shots}/harness-sidebar-tree.png` });
  // A PDF read inside a 230 pt sidebar keeps its other tools behind More, and nothing runs past the edge.
  await fileRow("report.pdf").click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open in tab", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  for (const name of ["Back to documents", "Open in tab", "Previous document", "Next document", "Find in document", "More actions", "Page map", "Mark reviewed", "Download original", "Previous page", "Next page", "Zoom in"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x + box.width, name).toBeLessThanOrEqual(230);
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(230);
  await page.screenshot({ path: `${shots}/harness-sidebar-reader.png` });
  await page.getByRole("button", { name: "Back to documents", exact: true }).click();
  // At the explorer's default 320 pt the stepper, Find and More share one row.
  await page.goto(`http://127.0.0.1:${port}/?width=320`);
  await showDocuments(page);
  await fileRow("report.pdf").click();
  const moreBox = await page.getByRole("button", { name: "More actions", exact: true }).boundingBox();
  for (const name of ["Previous document", "Next document", "Find in document"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(Math.abs(box.y - moreBox.y), name).toBeLessThan(2);
  }
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(320);
  await page.screenshot({ path: `${shots}/harness-explorer-reader.png` });
  // A split pane is wider than the narrow toolbar's 480 pt, so its tools wrap inside the pane.
  await page.goto(`http://127.0.0.1:${port}/?width=560`);
  await showDocuments(page);
  await fileRow("report.pdf").click();
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toBeVisible();
  for (const name of ["Open in tab", "Next document", "Find in document", "Page map", "Mark reviewed", "Download original", "Zoom in"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x + box.width, name).toBeLessThanOrEqual(560);
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(560);
  await page.screenshot({ path: `${shots}/harness-split-reader.png` });
  await page.goto(`http://127.0.0.1:${port}/?width=230`);
  await showDocuments(page);
  for (const name of ["contract.docx", "invoices.xlsx", "deck.pptx", "clip.mp4", "tone.wav", "animated.webp"]) {
    await page.getByRole("textbox", { name: "Search documents", exact: true }).fill(name.split(".")[0]);
    await fileRow(name).click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
    for (const control of ["Back to documents", "Open in tab", "More actions", "Download original"]) {
      const box = await page.getByRole("button", { name: control, exact: true }).boundingBox();
      expect(box.x + box.width, `${name}: ${control}`).toBeLessThanOrEqual(230);
    }
    expect(await page.evaluate(() => document.querySelector("main").scrollWidth), name).toBe(230);
    await page.screenshot({ path: `${shots}/harness-sidebar-${name}.png` });
    await page.getByRole("button", { name: "Back to documents", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await showDocuments(page);
  await viewButton("Tree view").click();
  const phoneSearch = await page.getByRole("textbox", { name: "Search documents", exact: true }).boundingBox();
  for (const option of ["List view", "Details view", "Previews view", "Tree view"]) {
    const box = await viewButton(option).boundingBox();
    expect(box.x + box.width, option).toBeLessThanOrEqual(390);
    expect(Math.abs(box.y + box.height / 2 - (phoneSearch.y + phoneSearch.height / 2)), option).toBeLessThanOrEqual(1);
  }
  await expect(page.getByRole("textbox", { name: "Search documents", exact: true })).toHaveAttribute("placeholder", "Search documents");
  const hint = await page.getByRole("textbox", { name: "Search documents", exact: true }).evaluate((input) => {
    const context = document.createElement("canvas").getContext("2d");
    context.font = getComputedStyle(input).font;
    return { text: context.measureText(input.placeholder).width, room: input.clientWidth };
  });
  expect(hint.text).toBeLessThan(hint.room);
  for (const row of [folderRow("exports"), fileRow("statement.pdf")]) expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await folderRow("docs").click();
  const phoneChevron = await folderRow("docs").locator('[data-icon="ChevronDown"]').boundingBox();
  expect((await fileRow("guide.pdf").locator('[data-icon="FileText"]').boundingBox()).x - phoneChevron.x).toBe(12);
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await page.screenshot({ path: `${shots}/harness-phone-tree.png` });
  // A new file splits the chain archive/2025/q4, which opened by default: both folders of its lower part stay open.
  const sinceSplit = await agentWrote(async () => writeFile(`${root}/archive/memo.pdf`, await readFile(`${root}/archive/2025/q4/ledger.pdf`)));
  await rpcAnswered(sinceSplit, "docs.recent");
  await expect(folderRow("archive")).toHaveAttribute("aria-expanded", "true");
  await expect(folderRow("2025/q4")).toHaveAttribute("aria-expanded", "true");
  await expect(fileRow("ledger.pdf")).toBeVisible();
  await expect(fileRow("memo.pdf")).toBeVisible();
  await viewButton("List view").click();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`);
  await showDocuments(page);
  await viewButton("List view").click();
  // Every kind reads inside Documents, Previous and Next cross kinds there, and Back finds the
  // search, type filter, collapsed headings and scroll as they were left.
  await page.evaluate(() => { window.__openedScreen = undefined; });
  const heading = (name) => page.getByRole("button", { name: new RegExp(`^${name}, \\d+( of \\d+)?$`) });
  const readerTitle = (pattern) => page.locator("main").getByLabel(pattern).filter({ visible: true });
  await heading("Images").click();
  await expect(heading("Images")).toHaveAttribute("aria-expanded", "false");
  const listScroller = page.getByRole("button", { name: /^contract\.docx, / }).evaluateHandle((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    return null;
  });
  const scrolled = await (await listScroller).evaluate((node) => { node.scrollTop = 200; return node.scrollTop; });
  expect(scrolled).toBeGreaterThan(100);
  await page.getByRole("button", { name: /^contract\.docx, / }).click();
  await expect(readerTitle("contract.docx")).toBeVisible();
  await expect(page.getByText(/^Document \d+ of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Previous document", exact: true }).click();
  await expect(readerTitle(/\.pdf$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Page map", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next document", exact: true }).click();
  await expect(readerTitle("contract.docx")).toBeVisible();
  await page.getByRole("button", { name: "Next document", exact: true }).click();
  await expect(readerTitle(/\.(xlsx|csv|tsv|jsonl|parquet)$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to documents", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__openedScreen)).toBeUndefined();
  await page.screenshot({ path: `${shots}/harness-panel-sheet.png` });
  await page.getByRole("button", { name: "Back to documents", exact: true }).click();
  await expect(heading("Images")).toHaveAttribute("aria-expanded", "false");
  expect(await (await listScroller).evaluate((node) => node.scrollTop)).toBe(scrolled);
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("contract");
  await page.getByRole("button", { name: /^Word, \d+ documents?$/ }).click();
  await page.getByRole("button", { name: /^contract\.docx, / }).click();
  await expect(readerTitle("contract.docx")).toBeVisible();
  await page.getByRole("button", { name: "Back to documents", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search documents", exact: true })).toHaveValue("contract");
  await expect(page.getByRole("button", { name: /^Word, \d+ documents?$/ })).toHaveAttribute("aria-pressed", "true");
  await expect(viewButton("List view")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^All, \d+ documents$/ }).click();
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("");
  await heading("Images").click();
  // A workspace without documents says what the scan did not reach, as a search that finds nothing does.
  const emptyScan = (route) => route.request().postDataJSON().method === "docs.recent"
    ? route.fulfill({ json: { entries: [], truncated: true, truncatedBy: ["entries", "depth"], counts: { pdf: 0, word: 0, excel: 0, powerpoint: 0, image: 0, video: 0, audio: 0 }, needsReview: 0, newCount: 0, version: "empty" } })
    : route.continue().catch(() => {});
  await page.route("**/rpc", emptyScan);
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.getByText("No documents yet", { exact: true })).toBeVisible();
  await expect(page.getByText(/ appear here\. Only the first 50,000 entries of this workspace were scanned\. Folders more than 16 levels deep were not scanned$/)).toBeVisible();
  await page.unroute("**/rpc", emptyScan);
  // Until the open choice is answered, the first document on a wide layout asks it once; phones never do.
  await fetch(`http://127.0.0.1:${port}/settings?openDocuments=unset`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?compact`);
  await page.getByRole("button", { name: "contract.docx", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  await expect(page.getByText("How should documents open?", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/?width=320`);
  await showDocuments(page);
  await page.getByRole("button", { name: /^contract\.docx, / }).click();
  await expect(page.getByText("How should documents open?", { exact: true })).toBeVisible();
  for (const name of ["Side by side, next to the chat", "Full view, in its own tab", "Decide for me (Auto)", "Open in tab"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x + box.width, name).toBeLessThanOrEqual(320 + 8);
  }
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth)).toBe(320);
  await page.screenshot({ path: `${shots}/harness-open-chooser.png` });
  await page.getByRole("button", { name: "Side by side, next to the chat", exact: true }).click();
  await expect(page.getByText("Documents open side by side from now on. Change it in Settings, Document viewer.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText(/^Documents open side by side/)).toHaveCount(0);
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  await expect(page.getByText("How should documents open?", { exact: true })).toHaveCount(0);
  // Phones always open the document screen. On a wide window Side by side shows the document in Documents in
  // the explorer, and Auto does from a 1,100 pt window.
  const reportPath = "reports/quarterly-report-with-a-long-file-name.pdf";
  const besideChat = { id: "documents", workspaceId: "workspace", location: "explorer" };
  const openFromCard = async (viewport, url = `http://127.0.0.1:${port}`) => {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole("button", { name: "Turn card", exact: true }).click();
    await page.getByRole("button", { name: pdfRow }).click();
  };
  const opened = () => page.evaluate(() => ({ screen: window.__openedScreen?.params?.path, panel: window.__openedPanel }));
  await openFromCard({ width: 390, height: 844 }, `http://127.0.0.1:${port}/?compact`);
  await expect(page.getByText("Document 1 of 4", { exact: true })).toBeVisible();
  expect(await opened()).toEqual({ screen: reportPath, panel: undefined });
  await openFromCard({ width: 1100, height: 1000 });
  await expect.poll(opened).toEqual({ screen: undefined, panel: besideChat });
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.locator("main").getByLabel(reportPath, { exact: true })).toBeVisible();
  await expect(page.getByText("Document 1 of 4", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/harness-side-by-side.png` });
  await fetch(`http://127.0.0.1:${port}/settings?openDocuments=auto`);
  await openFromCard({ width: 1099, height: 1000 });
  await expect.poll(opened).toEqual({ screen: reportPath, panel: undefined });
  await openFromCard({ width: 1100, height: 1000 });
  await expect.poll(opened).toEqual({ screen: undefined, panel: besideChat });
  expect(failures).toEqual([]);
  console.log("Browser checks passed: persisted page/zoom/sheet, reset, scoped find shortcut, PDF/Word/grid find navigation, Word table fills its card, cell inspector, record cards, bounded issue check, original-file download bytes, WAV decoding/playback, WebM audio-track playback, visible media/animation/download loading with cancel and navigation, stale-query/cancel/slow-position races, PDF page map (visible-first, at most two thumbnail requests, current page marked, open page, close stops requests), page pins (label, revisit after reopen, may need checking after rewrite, confirm, remove), review marks (explicit only, one button name in both states, Documents status, Needs review and New filters, rewrite race), Documents times read again on focus, New cleared by opening until the file changes, first-run tips (Next, Skip, Done, kept dismissed after reload, reopen, phone fit), review notes (collect, edit, preview, copy, busy preselected agent, stale, send), phone toolbar fit, JSON Lines (named columns, full value and copy, record JSON, invalid-line issues, find), turn card settings link (desktop, 390 px fit, fallback hint), turn card thumbnails, Opened pill and document stepper (desktop, phone row, per-document reset), turn card folder rows (collapsed checkout and new folder, Show and Hide under one name with aria-expanded, thumbnails and stepper only once shown, phone fit), kind colors and their setting, filter chip icons (status and type glyphs, hidden from screen readers, phone scroll, sidebar fit), view switch (beside search, kept per layout class, last press wins over a late answer, phone fit), Details (columns, phone rows), Previews (tiles with page count, rows for other kinds, sidebar rows, phone columns), Tree (folders first, counts, folder chains that stay open when a file splits them, tree items with levels, toggle, Space on rows, Expand all and Collapse all, search opens matches, folder siblings for the stepper, PDFs read in Documents with the stepper and in sidebar width, kept per layout class, sidebar row, phone fit), empty Documents saying what the scan did not reach, every kind read in Documents (sidebar fit, Previous and Next across kinds, Open in tab with folder siblings, Back keeps search, type filter, New and Needs review, collapsed headings and scroll), first-open chooser (wide only, 320 pt fit, saved, asked once), open routing (phones full screen, Side by side in the explorer, Auto from 1,100 pt), one toolbar row at 320 pt.");
} catch (error) { await saveFailure(); throw timedOut ? new Error(overLimit, { cause: error }) : error; } finally { await cleanUp(); }

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { compileLikePaseo } from "./paseo-compile";
import { PLUGIN_ROOT, workspace } from "./helpers";
import { compiledPlugin, PASEO_SOURCE } from "./paseo-real";

async function classSyntaxErrors(code: string): Promise<string[]> {
  try {
    await transform(code, { loader: "js", supported: { class: false }, logLevel: "silent" });
    return [];
  } catch (error) {
    const errors = (error as { errors?: { text: string; location?: { lineText?: string } | null }[] }).errors ?? [];
    return errors.map((entry) => `${entry.text}: ${entry.location?.lineText?.trim() ?? ""}`);
  }
}

describe("S11: client bundle loads on Hermes", () => {
  it("S11: the detector flags class syntax in a Paseo-compiled client bundle", async () => {
    const dir = workspace();
    const entry = join(dir, "index.client.ts");
    writeFileSync(entry, "class Counter { count = 0; }\nexport default function setup() { new Counter(); return () => {}; }\n");
    expect(await classSyntaxErrors(await compileLikePaseo("client", entry))).not.toEqual([]);
  });

  it("S11: the compiled client bundle contains no class syntax (getpaseo/paseo#5783)", async () => {
    expect(await classSyntaxErrors(await compileLikePaseo("client"))).toEqual([]);
  });
});

const HERMES_DIR = join(PLUGIN_ROOT, "node_modules/react-native/sdks/hermesc", { darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" }[process.platform as string] ?? "none");
const HERMES = [join(HERMES_DIR, "hermes"), join(HERMES_DIR, "hermes.exe")].find(existsSync) ?? null;
const HERMESC = [join(HERMES_DIR, "hermesc"), join(HERMES_DIR, "hermesc.exe")].find(existsSync) ?? null;
const NO_HERMES = `skipped: react-native ships no Hermes VM for ${process.platform}; run on macOS`;
const NO_HERMESC = `skipped: react-native ships no hermesc for ${process.platform}`;

async function clientBundle(): Promise<string> {
  if (!PASEO_SOURCE) return compileLikePaseo("client");
  const compiled = await compiledPlugin();
  if (compiled.error) throw new Error(compiled.error);
  return compiled.clientBundle;
}

function hermesProgram(bundle: string): string {
  return `
var log = print;
function noop() { return null; }
var setTimeout = noop;
var clearTimeout = noop;
var chain = new Proxy(function () {}, {
  get: function (_, key) { return key === "then" ? undefined : function () { return chain; }; },
  apply: function () { return chain; }
});
var host = {
  "react": { createElement: noop, useState: function (v) { return [v, noop]; }, useEffect: noop, useLayoutEffect: noop, useRef: function (v) { return { current: v }; }, useMemo: function (f) { return f(); }, useCallback: function (f) { return f; }, useReducer: function (r, s) { return [s, noop]; }, memo: function (c) { return c; } },
  "react/jsx-runtime": { jsx: noop, jsxs: noop, Fragment: "Fragment" },
  "react-native": { Platform: { OS: "ios", select: function (o) { return o.ios !== undefined ? o.ios : o.default; } }, StyleSheet: { create: function (s) { return s; } }, View: "View", Text: "Text", Image: "Image", ScrollView: "ScrollView", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", PixelRatio: { get: function () { return 3; } }, useWindowDimensions: function () { return { width: 390, height: 844 }; }, Dimensions: { get: function () { return { width: 390, height: 844 }; } } },
  "@tanstack/react-query": { useQuery: noop, useQueryClient: noop, useInfiniteQuery: noop },
  "@getpaseo/plugin": { defineRpc: function (contract) { return contract; }, defineSettings: function (definition) { return definition; }, settingsRpc: function (id) { return { read: { name: "settings." + id + ".read" } }; } },
  "@getpaseo/plugin/client": { useRpc: noop, useSettings: noop },
  "@getpaseo/plugin/client/ui": {},
  "@getpaseo/plugin/client/react-native": { Icon: noop, FlatList: noop },
  "zod": { z: chain, default: chain }
};
function hostRequire(name) {
  if (!Object.prototype.hasOwnProperty.call(host, name)) throw new Error('Module "' + name + '" is not available in plugin client code');
  return host[name];
}
var evaluate = globalThis.eval;
var setup = evaluate(${JSON.stringify(bundle)})(hostRequire)["default"];
var registered = { screen: [], cc: [], panel: [], slash: [], timeline: [], settings: [], header: [] };
function record(kind) { return function (c) { registered[kind].push(c); return noop; }; }
var subscription = { subscribe: function (observer) { observer.snapshot({ entries: [{ id: "ws" }] }); return noop; }, release: function () { return Promise.resolve(); } };
var paseo = { workspaces: { list: function () { return Promise.resolve({ entries: [], subscription: subscription }); } } };
function addHeaderButton(c) { registered.header.push(c); return { update: noop, remove: noop }; }
var cleanup = setup({ addScreen: record("screen"), addCommandCenterItem: record("cc"), addWorkspacePanel: record("panel"), addSlashCommand: record("slash"), addTimelineRenderer: record("timeline"), addSettingsScreen: record("settings"), addHeaderButton: addHeaderButton, openScreen: function (input) { opened.push(input); }, openPanel: function (id, options) { opened.push({ panel: id, options: options }); }, paseo: paseo, rpc: function (contract) { return Promise.resolve(contract.name === "docs.any" ? { found: true } : { entries: [{ path: "a.pdf" }] }); } });
var opened = [];
var context = {
  args: "", context: "workspace", workspace: { id: "ws" },
  openScreen: function (input) { opened.push(input); }, openPanel: noop,
  rpc: function () { return Promise.resolve({ entries: [{ path: "a.pdf", kind: "pdf", mtimeMs: 1, size: 1 }, { path: "b/new.pdf", kind: "pdf", mtimeMs: 9, size: 1 }], truncated: false }); }
};
log(JSON.stringify({ step: "contribute", cleanup: typeof cleanup, screens: registered.screen.length, commands: registered.cc.length, panels: registered.panel.length, slash: registered.slash.length, timeline: registered.timeline.map(function (c) { return c.kind + "@" + c.version; }), settings: registered.settings.length, title: registered.screen[0].title({ path: "report/main.pdf" }) }));
// setTimeout is stubbed, so let the header probe's promise chain settle before reading buttons.
function drain(ticks) { return ticks ? Promise.resolve().then(function () { return drain(ticks - 1); }) : Promise.resolve(); }
registered.slash[0].onSubmit(context).then(function () { return drain(20); }).then(
  function () { log(JSON.stringify({ step: "slash", opened: opened, headerButtons: registered.header.map(function (c) { return c.workspaceId + ":" + c.button.icon; }) })); },
  function (error) { log(JSON.stringify({ step: "slash", error: String(error) })); }
);
`;
}

describe("S11: client bundle runs on the Hermes VM", () => {
  it.skipIf(!HERMESC)(`S11: hermesc parses the compiled client bundle${HERMESC ? "" : ` (${NO_HERMESC})`}`, async () => {
    const file = join(workspace(), "bundle.js");
    writeFileSync(file, await clientBundle());
    const result = spawnSync(HERMESC!, ["-emit-binary", "-out", `${file}.hbc`, file], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  it.skipIf(!HERMES)(`S11: Hermes evaluates the bundle, runs contribute, and the /doc slash command opens the newest document${HERMES ? "" : ` (${NO_HERMES})`}`, async () => {
    const file = join(workspace(), "harness.js");
    writeFileSync(file, hermesProgram(await clientBundle()));
    const result = spawnSync(HERMES!, [file], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    const steps = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(steps).toEqual([
      { step: "contribute", cleanup: "function", screens: 2, commands: 3, panels: 1, slash: 1, timeline: ["turn-docs@1", "turn-docs@2"], settings: 1, title: "main.pdf · report" },
      { step: "slash", opened: [{ screenId: "document", params: { workspaceId: "ws", path: "b/new.pdf" } }], headerButtons: ["ws:FileText"] },
    ]);
  }, 120_000);
});

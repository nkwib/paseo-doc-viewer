import { mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { describe, expect, it, vi } from "vitest";
import * as zod from "zod";
import * as pluginRoot from "@getpaseo/plugin";
import { openDocument } from "../server/documents";
import { resolveInside } from "../server/paths";
import { detectKind } from "../shared/kinds";
import { compileLikePaseo, evaluateBundle } from "./paseo-compile";
import { GROUP_ICON, KIND_ICON } from "../client/format";
import { PLUGIN_ROOT, workspace } from "./helpers";
import { lucideIconNames, PASEO_SOURCE_MISSING } from "./paseo-real";

const HOST_STUBBED_MODULES = new Set([
  "react-native",
  "@tanstack/react-query",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
]);

function hostStub(): object {
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "__esModule") return true;
        if (key === "Platform") return { OS: "ios", select: (options: Record<string, unknown>) => options.ios ?? options.default };
        if (key === "StyleSheet") return { create: <T>(styles: T) => styles };
        // Under 1,100 pt, where Auto opens the standalone viewer.
        if (key === "Dimensions") return { get: () => ({ width: 1000, height: 800 }) };
        return () => null;
      },
    },
  );
}

const LUCIDE_ICONS = lucideIconNames();

function requireIcon(contribution: unknown): void {
  const icon = (contribution as { icon?: unknown }).icon;
  if (icon === undefined || !LUCIDE_ICONS) return;
  if (typeof icon !== "string" || !LUCIDE_ICONS.has(icon)) throw new Error(`Unknown Lucide icon: ${String(icon)}`);
}

interface Registered {
  screens: { id: string; title: string | ((params: Record<string, string>) => string) }[];
  commands: { id: string; context: string; onSelect(context: unknown): unknown }[];
  icons: string[];
}

async function loadClient(client: Record<string, unknown> = {}): Promise<Registered> {
  const bundle = await compileLikePaseo("client");
  const host: Record<string, unknown> = {
    react,
    "react/jsx-runtime": jsxRuntime,
    zod,
    "@getpaseo/plugin": pluginRoot,
  };
  const contribute = evaluateBundle<(client: unknown) => () => void>(bundle, (name) => {
    if (name in host) return host[name];
    if (HOST_STUBBED_MODULES.has(name)) return hostStub();
    throw new Error(`Module "${name}" is not available in plugin client code`);
  });
  const registered: Registered = { screens: [], commands: [], icons: [] };
  const record = (list: unknown[]) => (contribution: unknown) => {
    requireIcon(contribution);
    const icon = (contribution as { icon?: string }).icon;
    if (icon) registered.icons.push(icon);
    list.push(contribution);
    return () => {};
  };
  const subscription = {
    subscribe: (observer: { snapshot(snapshot: { entries: { id: string }[] }): void }) => {
      observer.snapshot({ entries: [{ id: "ws-1" }] });
      return () => {};
    },
    release: async () => {},
  };
  contribute(
    new Proxy(
      {
        addScreen: record(registered.screens),
        addCommandCenterItem: record(registered.commands),
        addHeaderButton: (contribution: { button: unknown }) => {
          record([])(contribution.button);
          return { update() {}, remove() {} };
        },
        paseo: { workspaces: { list: async () => ({ entries: [], subscription }) } },
        ...client,
      },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : record([])) },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return registered;
}

describe("S10: open a document by path despite the missing Files-tree hook", () => {
  it("S10: the client registers a document screen titled by params.path", async () => {
    const { screens } = await loadClient();
    const screen = screens.find((candidate) => candidate.id === "document");
    expect(screen, "document screen").toBeDefined();
    const title = typeof screen!.title === "function" ? screen!.title({ workspaceId: "ws-1", path: "report/main.pdf" }) : screen!.title;
    expect(title).toBe("main.pdf · report");
  });

  it("S10: a workspace Command Center item opens the most recently changed document in one tap", async () => {
    const openScreen = vi.fn();
    const { commands } = await loadClient({ openScreen });
    const command = commands.find((candidate) => candidate.context === "workspace");
    expect(command, "workspace command center item").toBeDefined();

    const rpc = vi.fn(async (contract: { name: string }) => {
      if (contract.name !== "docs.recent") throw new Error(`unexpected rpc ${contract.name}`);
      return {
        entries: [
          { path: "build/main.pdf", kind: "pdf", mtimeMs: 3, size: 10 },
          { path: "notes.docx", kind: "docx", mtimeMs: 1, size: 10 },
        ],
        truncated: false,
      };
    });
    await command!.onSelect({ context: "workspace", workspace: { id: "ws-1" }, rpc, openScreen, openPanel: vi.fn() });
    await vi.waitFor(() => expect(openScreen).toHaveBeenCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "build/main.pdf" } }));
  });

  it.skipIf(!LUCIDE_ICONS)(
    `S10: every registered icon is in Paseo's Lucide set${LUCIDE_ICONS ? "" : ` (skipped: ${PASEO_SOURCE_MISSING})`}`,
    async () => {
      const { icons } = await loadClient();
      expect(icons.length).toBeGreaterThan(0);
      const rendered = ["index.client.tsx", ...readdirSync(join(PLUGIN_ROOT, "client")).map((name) => join("client", name))]
        .flatMap((file) => {
          const source = readFileSync(join(PLUGIN_ROOT, file), "utf8");
          const props = [...source.matchAll(/\bicon(?:=|: )"(\w+)"/g)].map((match) => match[1]);
          const elements = [...source.matchAll(/<Icon name=(\{[^}]*\}|"\w+")/g)].flatMap((match) =>
            [...match[1].matchAll(/"(\w+)"/g)].map((quoted) => quoted[1]),
          );
          return [...props, ...elements];
        });
      for (const icon of [...icons, ...rendered, ...Object.values(KIND_ICON), ...Object.values(GROUP_ICON)]) {
        expect.soft(LUCIDE_ICONS!.has(icon), icon).toBe(true);
      }
    },
  );

  it("S10: a params.path that escapes the workspace is rejected", async () => {
    const root = workspace({ "inside.pdf": "%PDF-1.4" });
    const outside = workspace({ "secret.pdf": "%PDF-1.4" });
    mkdirSync(join(root, "links"));
    symlinkSync(join(outside, "secret.pdf"), join(root, "links/secret.pdf"));

    await expect(resolveInside(root, "inside.pdf")).resolves.toMatch(/inside\.pdf$/);
    await expect(resolveInside(root, "../secret.pdf")).rejects.toThrow(/outside the workspace/i);
    await expect(resolveInside(root, join(outside, "secret.pdf"))).rejects.toThrow(/outside the workspace/i);
    await expect(resolveInside(root, "links/secret.pdf")).rejects.toThrow(/outside the workspace/i);
    await expect(openDocument({ root, path: "links/secret.pdf" })).rejects.toThrow(/outside the workspace/i);
  });

  it("S10: the plugin classifies files itself by extension and magic bytes, since the daemon labels .pdf as octet-stream", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectKind("build/main.pdf", bytes("%PDF-1.7\n"))).toBe("pdf");
    expect(detectKind("MAIN.PDF", bytes("%PDF-1.7\n"))).toBe("pdf");
    expect(detectKind("main.pdf", png)).toBeNull();
    expect(detectKind("photo.png", png)).toBe("image-raster");
    expect(detectKind("clip.mp4", bytes("\0\0\0\x18ftypisom"))).toBe("video");
    expect(detectKind("photo.heic", bytes("\0\0\0\x18ftypheic"))).toBe("image-decoded");
    expect(detectKind("notes.txt", bytes("hello"))).toBeNull();
  });
});

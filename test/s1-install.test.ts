import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import * as pluginRoot from "@getpaseo/plugin";
import * as pluginServer from "@getpaseo/plugin/server";
import * as zod from "zod";
import { MAX_RESPONSE_BYTES } from "../shared/limits";
import { DOCUMENT_RPCS } from "../shared/rpc";
import { PLUGIN_ROOT, decodePng, responseBytes, workspaceWithFixtures } from "./helpers";
import { compileLikePaseo, evaluateBundle } from "./paseo-compile";
import { compileWithPaseo, PASEO_SOURCE, PASEO_SOURCE_MISSING } from "./paseo-real";

const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return CODE.has(extname(name)) ? [full] : [];
  });
}

function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ];
  return found.map((match) => match[1]);
}

const isNode = (specifier: string) =>
  specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]);

describe("S1: plugin installs on Paseo 0.13", () => {
  it("S1: manifest and layout satisfy the Paseo 0.13.0 plugin contract", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, "paseo-plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"));

    expect.soft(manifest.id).toBe("paseo-doc-viewer");
    expect.soft(manifest.requirements?.paseo, "requirements.paseo").toBe(">=0.13.0");
    expect.soft(manifest.build, "build installs runtime dependencies on git installs").toEqual([
      ["npm", "ci", "--omit=dev", "--ignore-scripts"],
    ]);

    expect.soft(Object.keys(manifest).filter((key) => key.startsWith("$")), "no editor comments in the manifest").toEqual([]);
    expect.soft(manifest.name, "listing name").toBeTruthy();
    expect.soft(manifest.description, "listing description").toBeTruthy();
    expect.soft(manifest.icon, "listing icon").toMatch(/^assets\/[\w-]+\.png$/);
    expect.soft(manifest.media?.length ?? 0, "listing media").toBeGreaterThanOrEqual(2);
    for (const asset of [manifest.icon, ...(manifest.media ?? [])]) {
      expect.soft(decodePng(readFileSync(join(PLUGIN_ROOT, asset)).toString("base64")).width, asset).toBeGreaterThan(0);
      expect.soft(pkg.files.some((entry: string) => asset === entry || asset.startsWith(entry)), `${asset} is in package files`).toBe(true);
    }
    for (const file of ["OVERVIEW.md", "LICENSE", "NOTICE"]) {
      expect.soft(existsSync(join(PLUGIN_ROOT, file)), file).toBe(true);
      expect.soft(pkg.files, file).toContain(file);
    }
    const overview = readFileSync(join(PLUGIN_ROOT, "OVERVIEW.md"), "utf8");
    expect.soft(overview, "overview has no install commands").not.toMatch(/paseo plugin add|npm install|npm i\b/);
    expect.soft(overview, "overview has no em dashes").not.toContain("\u2014");
    expect.soft(overview, "overview has no template comment").not.toContain("<!--");

    const hostProvided = /^(@getpaseo\/|zod$|react$|react-native$|@tanstack\/react-query$)/;
    const packageName = (specifier: string) =>
      specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    const imported = new Set(
      [...codeFiles(join(PLUGIN_ROOT, "server")), ...codeFiles(join(PLUGIN_ROOT, "shared")), join(PLUGIN_ROOT, "index.server.ts")]
        .flatMap(specifiers)
        .filter((specifier) => !specifier.startsWith(".") && !isNode(specifier))
        .map(packageName)
        .filter((name) => !hostProvided.test(name)),
    );
    expect.soft(imported.size, "server imports runtime packages").toBeGreaterThan(0);
    for (const name of imported) {
      expect.soft(pkg.dependencies?.[name], `${name} is imported by server code so it must be a runtime dependency`).toBeDefined();
    }

    const rootCode = readdirSync(PLUGIN_ROOT).filter(
      (name) => CODE.has(extname(name)) && statSync(join(PLUGIN_ROOT, name)).isFile(),
    );
    expect.soft(rootCode.sort(), "only runtime entries live in the plugin root").toEqual([
      "index.client.tsx",
      "index.server.ts",
    ]);

    for (const file of codeFiles(join(PLUGIN_ROOT, "shared"))) {
      for (const specifier of specifiers(file)) {
        const where = `${relative(PLUGIN_ROOT, file)} imports ${specifier}`;
        expect.soft(/(^|\/)(server|client)(\/|$)/.test(specifier), where).toBe(false);
        expect.soft(isNode(specifier), where).toBe(false);
        expect.soft(specifier.startsWith("react"), where).toBe(false);
      }
    }
    for (const file of [join(PLUGIN_ROOT, "index.client.tsx"), ...codeFiles(join(PLUGIN_ROOT, "client"))]) {
      for (const specifier of specifiers(file)) {
        const where = `${relative(PLUGIN_ROOT, file)} imports ${specifier}`;
        expect.soft(isNode(specifier), where).toBe(false);
        expect.soft(/(^|\/)server(\/|$)/.test(specifier), where).toBe(false);
      }
    }
    for (const file of [join(PLUGIN_ROOT, "index.server.ts"), ...codeFiles(join(PLUGIN_ROOT, "server"))]) {
      for (const specifier of specifiers(file)) {
        const where = `${relative(PLUGIN_ROOT, file)} imports ${specifier}`;
        expect.soft(/^(react|react-native)(\/|$)/.test(specifier), where).toBe(false);
        expect.soft(/(^|\/)client(\/|$)/.test(specifier), where).toBe(false);
      }
    }
  });

  it("S1: server bundle compiled like Paseo registers every document RPC and renders a PDF page", async () => {
    const bundle = await compileLikePaseo("server");
    const outside = createRequire(join(tmpdir(), "outside-plugin.cjs"));
    const host: Record<string, unknown> = {
      "@getpaseo/plugin": pluginRoot,
      "@getpaseo/plugin/server": pluginServer,
      zod,
    };
    const contribute = evaluateBundle<(server: unknown) => () => void>(bundle, (name) => host[name] ?? outside(name));

    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    contribute({ registerSettings: () => ({ read: async () => ({ status: "ready", revision: "", values: { turnCards: true } }), subscribe: () => () => {} }), on: () => () => {}, handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) } as never);
    expect([...handlers.keys()].sort()).toEqual(DOCUMENT_RPCS.map((rpc) => rpc.name).sort());

    const root = workspaceWithFixtures("statement.pdf");
    const paseo = {
      workspaces: {
        list: async () => ({
          entries: [{ id: "ws-1", workspaceDirectory: root, projectRootPath: root }],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        }),
      },
    };
    const page = (await handlers.get("doc.page")!({ workspaceId: "ws-1", path: "statement.pdf", index: 0 }, { paseo })) as {
      kind: string;
      image: { data: string };
    };
    expect(page.kind).toBe("pdf");
    expect(decodePng(page.image.data).width).toBeGreaterThan(0);
    expect(responseBytes(page)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    const text = await handlers.get("doc.text")!({ workspaceId: "ws-1", path: "statement.pdf", index: 2 }, { paseo });
    expect(text).toMatchObject({ kind: "pdf", index: 2, pageCount: 3, truncated: false });
  }, 60_000);

  it.skipIf(!PASEO_SOURCE)(
    `S1: after the manifest build installs production dependencies only, Paseo's own compilePlugin accepts the plugin and its server bundle renders a PDF page and a WebP${PASEO_SOURCE ? "" : ` (skipped: ${PASEO_SOURCE_MISSING})`}`,
    async () => {
      const copy = mkdtempSync(join(tmpdir(), "paseo-doc-viewer-install-"));
      onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: PLUGIN_ROOT, encoding: "utf8" })
        .split("\0")
        .filter((file) => file && existsSync(join(PLUGIN_ROOT, file)));
      for (const file of files) cpSync(join(PLUGIN_ROOT, file), join(copy, file));
      const manifest = JSON.parse(readFileSync(join(copy, "paseo-plugin.json"), "utf8")) as { build: string[][] };
      for (const [command, ...args] of manifest.build) {
        execFileSync(command, [...args, "--prefer-offline", "--no-audit", "--no-fund"], { cwd: copy, stdio: "pipe" });
      }
      expect(existsSync(join(copy, "node_modules/vitest")), "dev dependencies are not installed").toBe(false);

      const compiled = await compileWithPaseo(copy);
      expect(compiled.error, "compilePlugin error").toBeUndefined();
      expect(compiled.clientBundle.length).toBeGreaterThan(0);
      expect(compiled.handlers.sort()).toEqual(DOCUMENT_RPCS.map((rpc) => rpc.name).sort());
      const page = compiled.page as { kind: string; image: { data: string } };
      expect(page.kind).toBe("pdf");
      expect(decodePng(page.image.data).width).toBeGreaterThan(0);
      expect(responseBytes(page)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      const webp = compiled.webp as { kind: string; image: { data: string } };
      expect(webp.kind).toBe("image-decoded");
      expect(decodePng(webp.image.data)).toMatchObject({ width: 64, height: 48 });
    },
    180_000,
  );
});

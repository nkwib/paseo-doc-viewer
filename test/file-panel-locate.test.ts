import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import { openDocument } from "../server/documents";
import { workspacePath } from "../server/paths";
import { docLocateRpc } from "../shared/rpc";
import { workspace, workspaceWithFixtures } from "./helpers";

const OUTSIDE = /outside the workspace/i;

describe("doc.locate: a file tab's absolute path as a workspace path", () => {
  it("maps a file inside the workspace, named through the root as configured or resolved", async () => {
    // The daemon resolves the root; Paseo names the file through the folder as configured, which on
    // macOS is a link when it is under the temporary folder (/var to /private/var).
    const configured = workspace({ "reports/q1.pdf": "%PDF-1.4" });
    const root = realpathSync(configured);
    await expect(workspacePath(root, join(configured, "reports/q1.pdf"))).resolves.toBe("reports/q1.pdf");
    await expect(workspacePath(root, join(root, "reports/q1.pdf"))).resolves.toBe("reports/q1.pdf");
    await expect(workspacePath(root, `${configured}/reports/../reports/q1.pdf`)).resolves.toBe("reports/q1.pdf");
  });

  it("maps a link from outside to a file inside to the file's own path", async () => {
    const root = workspace({ "reports/q1.pdf": "%PDF-1.4" });
    const elsewhere = workspace();
    symlinkSync(root, join(elsewhere, "checkout"));
    await expect(workspacePath(root, join(elsewhere, "checkout/reports/q1.pdf"))).resolves.toBe("reports/q1.pdf");
  });

  it("rejects a file outside the workspace, and a missing one there without saying whether it exists", async () => {
    const root = workspace({ "inside.pdf": "%PDF-1.4" });
    const outside = workspace({ "secret.pdf": "%PDF-1.4" });
    await expect(workspacePath(root, join(outside, "secret.pdf"))).rejects.toThrow(OUTSIDE);
    await expect(workspacePath(root, join(outside, "missing.pdf"))).rejects.toThrow(OUTSIDE);
  });

  it("rejects `..` segments that leave the workspace", async () => {
    const root = workspace({ "reports/q1.pdf": "%PDF-1.4" });
    const outside = workspace({ "secret.pdf": "%PDF-1.4" });
    await expect(workspacePath(root, `${root}/../${basename(outside)}/secret.pdf`)).rejects.toThrow(OUTSIDE);
    await expect(workspacePath(root, `${root}/reports/../../${basename(outside)}/secret.pdf`)).rejects.toThrow(OUTSIDE);
  });

  it("rejects links inside the workspace that lead out, to a file or through a folder", async () => {
    const root = workspace({ "inside.pdf": "%PDF-1.4" });
    const outside = workspace({ "secret.pdf": "%PDF-1.4" });
    mkdirSync(join(root, "links"));
    symlinkSync(join(outside, "secret.pdf"), join(root, "links/secret.pdf"));
    symlinkSync(outside, join(root, "links/folder"));
    await expect(workspacePath(root, join(root, "links/secret.pdf"))).rejects.toThrow(OUTSIDE);
    await expect(workspacePath(root, join(root, "links/folder/secret.pdf"))).rejects.toThrow(OUTSIDE);
  });

  it("says a missing file inside the workspace is not found, and refuses paths that are not absolute", async () => {
    const root = realpathSync(workspace({ "inside.pdf": "%PDF-1.4" }));
    await expect(workspacePath(root, join(root, "gone/missing.pdf"))).rejects.toThrow("File not found: gone/missing.pdf");
    await expect(workspacePath(root, "inside.pdf")).rejects.toThrow(/invalid path/i);
    await expect(workspacePath(root, `${join(root, "inside.pdf")}\0.png`)).rejects.toThrow(/invalid path/i);
  });

  it("answers through the daemon handler with a path the reader opens", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    contribute({ registerSettings: () => ({ read: async () => null, subscribe: () => () => {} }), on: () => () => {}, handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) } as never);
    const paseo = { workspaces: { list: async () => ({ entries: [{ id: "ws", workspaceDirectory: root }], pageInfo: { hasMore: false } }) } };
    const located = docLocateRpc.output.parse(await handlers.get("doc.locate")!(docLocateRpc.input.parse({ workspaceId: "ws", absolutePath: join(root, "statement.pdf") }), { paseo }));
    expect(located).toEqual({ path: "statement.pdf" });
    await expect(openDocument({ root, path: located.path })).resolves.toMatchObject({ kind: "pdf" });
    await expect(handlers.get("doc.locate")!({ workspaceId: "ws", absolutePath: "/etc/hosts" }, { paseo })).rejects.toThrow(OUTSIDE);
  });
});

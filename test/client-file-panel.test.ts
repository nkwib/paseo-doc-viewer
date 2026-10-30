import { describe, expect, it, vi } from "vitest";
import type { PluginFilePanelContribution } from "@getpaseo/plugin/client";
import { addFilePanel, FILE_PANEL_EXTENSIONS } from "../client/file-panel";
import { DOCUMENT_KINDS, KIND_REGISTRY } from "../shared/kinds";

const Component = () => null;

// What addFilePanel accepts in Paseo 0.13.0 (packages/app/src/plugins/evaluate.ts).
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;
function acceptedSelector(files: unknown): boolean {
  const valid = (entries: unknown, extension: boolean) =>
    Array.isArray(entries) && entries.every((entry) =>
      typeof entry === "string" && entry.trim() === entry && entry.length > 0 && !/[\\/*?]/.test(entry) && (!extension || !entry.includes(".")));
  if (typeof files !== "object" || files === null) return false;
  const selector = files as { extensions?: unknown; filenames?: unknown };
  return Object.keys(selector).every((key) => key === "extensions" || key === "filenames") &&
    valid(selector.extensions, true) && (selector.filenames === undefined || valid(selector.filenames, false)) &&
    ((selector.extensions as string[]).length > 0 || (Array.isArray(selector.filenames) && selector.filenames.length > 0));
}

describe("file panel registration", () => {
  it("registers one panel Paseo 0.13.0 accepts, and returns the host's cleanup", () => {
    const remove = vi.fn();
    const add = vi.fn((_contribution: PluginFilePanelContribution) => remove);
    const cleanup = addFilePanel({ addFilePanel: add } as never, Component);
    expect(add).toHaveBeenCalledTimes(1);
    const contribution = add.mock.calls[0]![0];
    expect(contribution.id).toMatch(CONTRIBUTION_ID);
    expect(contribution.title.trim()).not.toBe("");
    expect(typeof contribution.Component).toBe("function");
    expect(acceptedSelector(contribution.files)).toBe(true);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("file panel claims", () => {
  it("are lowercase extensions without a dot, path or wildcard characters, each once", () => {
    expect(acceptedSelector({ extensions: FILE_PANEL_EXTENSIONS })).toBe(true);
    for (const extension of FILE_PANEL_EXTENSIONS) expect(extension).toMatch(/^[a-z0-9]+$/);
    expect(new Set(FILE_PANEL_EXTENSIONS).size).toBe(FILE_PANEL_EXTENSIONS.length);
  });

  it("cover every kind the viewer reads, with images only where Paseo's Image panel cannot show them", () => {
    const read = DOCUMENT_KINDS.flatMap((kind) => KIND_REGISTRY[kind].extensions);
    expect(read).toEqual(expect.arrayContaining([...FILE_PANEL_EXTENSIONS]));
    expect([...FILE_PANEL_EXTENSIONS].sort()).toEqual(read.filter((extension) => !["png", "jpg", "jpeg", "gif", "webp"].includes(extension)).sort());
    expect(FILE_PANEL_EXTENSIONS).toEqual(expect.arrayContaining(["pdf", "docx", "xlsx", "pptx", "parquet", "csv", "tsv", "jsonl", "ndjson", "mp4", "mp3", "tif", "tiff", "heic", "heif"]));
  });
});

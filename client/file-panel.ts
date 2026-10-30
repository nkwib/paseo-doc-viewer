import type { PluginClientContext, PluginFilePanelContribution } from "@getpaseo/plugin/client";
import { DOCUMENT_KINDS, KIND_REGISTRY } from "../shared/kinds";

// Paseo's Image panel shows these. Claiming them would only add a prompt, so the viewer claims the
// images a browser cannot show (TIFF, HEIC) and every other kind it reads.
const PASEO_IMAGE_PANEL = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export const FILE_PANEL_EXTENSIONS: readonly string[] = DOCUMENT_KINDS.flatMap((kind) => KIND_REGISTRY[kind].extensions)
  .filter((extension) => !PASEO_IMAGE_PANEL.has(extension));

export function addFilePanel(client: PluginClientContext, Component: PluginFilePanelContribution["Component"]) {
  return client.addFilePanel({ id: "viewer", title: "Viewer", icon: "FileText", files: { extensions: FILE_PANEL_EXTENSIONS }, Component });
}

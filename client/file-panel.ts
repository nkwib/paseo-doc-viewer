import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { DOCUMENT_KINDS, KIND_REGISTRY } from "../shared/kinds";

// Local, not the SDK's PluginFilePanelProps: the SDK devDependency matches the oldest supported host, which has no file panels.
export interface FilePanelProps extends PluginHostProps {
  workspaceId: string;
  file: { readonly path: string };
}

export interface FilePanelContribution {
  id: string;
  title: string;
  icon: string;
  files: { extensions: readonly string[] };
  // A function: Paseo refuses other component types, such as memo objects.
  Component: (props: FilePanelProps) => ReactNode;
}

export interface FilePanelHost {
  addFilePanel?: (contribution: FilePanelContribution) => () => void;
}

// Paseo's Image panel shows these. Claiming them would only add a prompt, so the viewer claims the
// images a browser cannot show (TIFF, HEIC) and every other kind it reads.
const PASEO_IMAGE_PANEL = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export const FILE_PANEL_EXTENSIONS: readonly string[] = DOCUMENT_KINDS.flatMap((kind) => KIND_REGISTRY[kind].extensions)
  .filter((extension) => !PASEO_IMAGE_PANEL.has(extension));

// Paseo 0.13.0 added addFilePanel. Older hosts have none, and calling it there would stop the whole client.
export function addFilePanel(client: PluginClientContext, Component: FilePanelContribution["Component"]): () => void {
  const host = client as PluginClientContext & FilePanelHost;
  if (typeof host.addFilePanel !== "function") return () => {};
  return host.addFilePanel({ id: "viewer", title: "Viewer", icon: "FileText", files: { extensions: FILE_PANEL_EXTENSIONS }, Component });
}

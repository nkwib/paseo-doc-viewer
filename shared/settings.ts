import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const viewerSettings = defineSettings({
  id: "viewer",
  scope: "host",
  version: 1,
  schema: z.object({
    // A timeline card per agent turn listing the documents that changed while it ran.
    turnCards: z.boolean().default(true),
    kindColors: z.boolean().default(true),
    // Where a document opens on a wide layout; unset until the first-open chooser is answered, and read as auto.
    openDocuments: z.enum(["auto", "side", "full"]).optional(),
  }),
});

// The host serves these as ordinary plugin RPCs, so surfaces without the settings hook can read them.
export const viewerSettingsRpc = settingsRpc(viewerSettings.id);

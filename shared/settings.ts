import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const viewerSettings = defineSettings({
  id: "viewer",
  scope: "host",
  version: 1,
  schema: z.object({
    // A timeline card per agent turn listing the documents that changed while it ran.
    // Kept as the on/off it always was, so a client from before the scope option still reads it.
    turnCards: z.boolean().default(true),
    // Which documents a turn card lists; unset reads as "session". Only meaningful while turnCards is on.
    turnCardsScope: z.enum(["session", "workspace"]).optional(),
    kindColors: z.boolean().default(true),
    // Where a document opens on a wide layout; unset until the first-open chooser is answered, and read as auto.
    openDocuments: z.enum(["auto", "side", "full"]).optional(),
  }),
});

// The host serves these as ordinary plugin RPCs, so surfaces without the settings hook can read them.
export const viewerSettingsRpc = settingsRpc(viewerSettings.id);

export type TurnCardsMode = "session" | "workspace" | "off";

// The Turn cards setting is one select over the two stored fields: Off is turnCards false.
export function turnCardsMode(values: { turnCards: boolean; turnCardsScope?: "session" | "workspace" }): TurnCardsMode {
  return !values.turnCards ? "off" : (values.turnCardsScope ?? "session");
}

// Off keeps the stored scope, so another client still reading only turnCards sees a plain off, and switching
// on again from here starts from a chosen scope.
export function withTurnCardsMode<T extends { turnCards: boolean; turnCardsScope?: "session" | "workspace" }>(values: T, mode: TurnCardsMode): T {
  return mode === "off" ? { ...values, turnCards: false } : { ...values, turnCards: true, turnCardsScope: mode };
}

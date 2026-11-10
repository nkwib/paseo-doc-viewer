import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { REVIEW_MAX_IMAGES, REVIEW_MAX_NOTE_CHARS } from "../shared/limits";
import { reviewPageImageRpc } from "../shared/rpc";
import { errorText } from "../shared/errors";
import { pageImageKey, reviewDrafts, reviewUnit, type ReviewDraft, type ReviewNote, type ReviewUnit } from "./review-draft";
import { Checkbox, ToolbarButton, type Styles } from "./ui";

export const REVIEW_SCREEN_ID = "review";

export function reviewScreen(workspaceId: string) {
  return { screenId: REVIEW_SCREEN_ID, params: { workspaceId } };
}

export function canAttachPage(draft: ReviewDraft, note: Pick<ReviewNote, "path" | "revision" | "page" | "unit">): boolean {
  return reviewUnit(note) === "page" && (pageImageKey(note) in draft.images || Object.keys(draft.images).length < REVIEW_MAX_IMAGES);
}

export function useAttachPage(workspaceId: string) {
  const render = useRpc(reviewPageImageRpc);
  return async (scope: string, note: ReviewNote, password?: string) => {
    if (reviewUnit(note) !== "page") throw new Error("Slide notes are text-only");
    const { image } = await render({ workspaceId, path: note.path, password, revision: note.revision, index: note.page });
    if (!reviewDrafts.attachImage(scope, pageImageKey(note), image)) throw new Error(`At most ${REVIEW_MAX_IMAGES} page images can be attached`);
  };
}

export function NoteComposer({ scope, workspaceId, path, revision, page, unit = "page", password, draft, theme, styles, onClose }: {
  scope: string; workspaceId: string; path: string; revision: string; page: number; password?: string; draft: ReviewDraft;
  unit?: ReviewUnit;
  theme: PluginTheme; styles: Styles; onClose(): void;
}) {
  const toast = useToast();
  const attachPage = useAttachPage(workspaceId);
  // The note refers to the revision on screen when its text was started, not when the editor opened.
  const [pinned, setPinned] = useState<string | null>(() => {
    const kept = reviewDrafts.composing(scope, path);
    return kept?.page === page && reviewUnit(kept) === unit && kept.text.trim() ? kept.revision : null;
  });
  const anchorRevision = pinned ?? revision;
  const [text, setText] = useState(() => {
    const kept = reviewDrafts.composing(scope, path);
    return kept?.page === page && reviewUnit(kept) === unit ? kept.text : "";
  });
  const type = (value: string) => {
    const anchor = value.trim() ? anchorRevision : null;
    setPinned(anchor);
    setText(value);
    reviewDrafts.setComposing(scope, path, { revision: anchor ?? revision, page, unit, text: value });
  };
  const close = () => {
    reviewDrafts.setComposing(scope, path, null);
    onClose();
  };
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const attachable = anchorRevision === revision && canAttachPage(draft, { path, revision: anchorRevision, page, unit });
  const add = async () => {
    const note = reviewDrafts.addNote(scope, { path, revision: anchorRevision, page, unit, text });
    if (!note) {
      if (text.trim()) toast.error("The review draft is full; send or remove notes first");
      return;
    }
    setBusy(true);
    try {
      if (attach && attachable) await attachPage(scope, note, password);
      toast.show(`Note added to ${unit} ${page + 1}`);
    } catch (failure) {
      toast.error(`Note added without the page image: ${errorText(failure)}`);
    }
    close();
  };
  return (
    <View style={[styles.toolbar, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
      <Text style={styles.label}>Note on {unit} {page + 1}</Text>
      {anchorRevision !== revision ? <Text style={[styles.label, { color: theme.colors.statusWarning }]}>The file changed while you were writing. This note refers to the older version.</Text> : null}
      <TextInput
        value={text}
        onChangeText={type}
        multiline
        autoFocus
        maxLength={REVIEW_MAX_NOTE_CHARS}
        placeholder={`What should change on this ${unit}?`}
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Note text"
        style={[styles.text, styles.card, { minHeight: 64, padding: 8, textAlignVertical: "top" }]}
      />
      <View style={styles.toolbarGroup}>
        {unit === "page" ? <Checkbox theme={theme} styles={styles} label="Attach page image" checked={attach && attachable} disabled={!attachable || busy} onChange={setAttach} /> : null}
        <View style={styles.toolbarSpacer} />
        <ToolbarButton theme={theme} styles={styles} label="Cancel" disabled={busy} onPress={close} />
        <ToolbarButton theme={theme} styles={styles} icon="Check" label="Add note" variant="primary" disabled={!text.trim() || busy} onPress={() => void add()} />
      </View>
      {unit === "page" && anchorRevision === revision && !attachable ? <Text style={styles.muted}>{REVIEW_MAX_IMAGES} page images are already attached</Text> : null}
      <Text style={styles.muted}>Notes stay on this device until sent and are lost when the app reloads.</Text>
    </View>
  );
}

import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useEffect, useMemo, useReducer, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { viewerSettingsRpc } from "../shared/settings";
import { type TurnDocs, type TurnDocsFile, type TurnDocsGroup, type TurnDocsV1, upgradeTurnDocs } from "../shared/turn-docs";
import { cardThumbnailIndices, createCardThumbnails, nextCardPriority } from "./card-thumbnails";
import { listedFiles, TURN_CARDS_SETTING_HINT, TURN_FILE_PILL, TURN_GROUP, TURN_THUMBNAIL_SIZE, turnDocsNote, turnDocsTitle, turnFilePill, type TurnFilePill } from "./turn-docs";
import { baseName, humanSize, KIND_ICON, KIND_LABEL, parentDir } from "./format";
import { kindColor, type KindPalette } from "./kind-colors";
import { watchOpenedRevisions } from "./opened-marks";
import { documentScreen, SETTINGS_SCREEN_ID } from "./recent";
import type { DocumentOpener } from "./open-target";
import type { ThumbnailLoader, ThumbnailState } from "./thumbnails";
import { makeStyles, StatusPill, ToolbarButton, type Styles } from "./ui";
import { useKindPalette } from "./use-kind-colors";

type CardClient = Pick<PluginClientContext, "openSettings" | "rpc"> & { openDocument: DocumentOpener; showDocuments(workspaceId: string): void };
type Theme = PluginTimelineItemProps["theme"];

// Closes over the client: timeline item props carry no navigation or RPC provider in this SDK.
export function createTurnDocsCard(client: CardClient) {
  return function TurnDocsCard({ item, theme, layout }: PluginTimelineItemProps<TurnDocs>) {
    const data = item.data;
    const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
    const size = layout.compact ? TURN_THUMBNAIL_SIZE.compact : TURN_THUMBNAIL_SIZE.wide;
    const [expanded, toggle] = useReducer(toggled, NOTHING_EXPANDED);
    const carried = [...data.files, ...data.groups.flatMap((group) => group.files)];
    const listed = listedFiles(data, expanded);
    const thumbnails = useCardThumbnails(client, data.workspaceId, carried, listed);
    const opened = useOpenedRevisions(client, data.workspaceId, listed);
    const palette = useKindPalette(theme, () => client.rpc(viewerSettingsRpc.read, {}));
    const siblings = listed.map((file) => file.path);
    const [settingsFailed, setSettingsFailed] = useState(false);
    const note = turnDocsNote(data);
    // The host throws when it cannot open the screen; an exception in a press handler is fatal on native.
    const openSettings = () => {
      try {
        client.openSettings(SETTINGS_SCREEN_ID);
      } catch {
        setSettingsFailed(true);
      }
    };
    const openDocuments = () => client.showDocuments(data.workspaceId);
    const fileRow = (file: TurnDocsFile, index: number, within = "") => (
      <FileRow
        key={file.path}
        file={file}
        within={within}
        thumbnail={thumbnails?.state(index)}
        pill={turnFilePill(file, opened[file.path])}
        palette={palette}
        size={size}
        styles={styles}
        theme={theme}
        onOpen={() => client.openDocument(documentScreen(data.workspaceId, file.path, siblings), layout)}
      />
    );
    let offset = data.files.length;
    return (
      <View style={[styles.card, { paddingVertical: 8, paddingHorizontal: layout.compact ? 8 : 10, gap: 2, marginVertical: 4 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
          <Icon name="Files" size={14} color={theme.colors.foregroundMuted} />
          <Text style={[styles.muted, { flex: 1, fontSize: 13 }]} numberOfLines={2}>
            {turnDocsTitle(data)}
          </Text>
          <SettingsLink theme={theme} styles={styles} onPress={openSettings} />
        </View>
        {data.files.map((file, index) => fileRow(file, index))}
        {data.groups.map((group) => {
          const first = offset;
          offset += group.files.length;
          const open = expanded.has(group.path);
          return (
            <View key={`group:${group.path}`}>
              <GroupRow group={group} open={open} size={size} styles={styles} theme={theme} onToggle={() => toggle(group.path)} />
              {open ? (
                <View style={{ marginLeft: size / 2 + 4, paddingLeft: 6, borderLeftWidth: 1, borderLeftColor: theme.colors.border }}>
                  {group.files.map((file, index) => fileRow(file, first + index, group.path))}
                  {group.count > group.files.length ? (
                    <MoreInDocuments count={group.count - group.files.length} styles={styles} theme={theme} onPress={openDocuments} />
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
        {data.moreCount > 0 ? <MoreInDocuments count={data.moreCount} styles={styles} theme={theme} onPress={openDocuments} /> : null}
        {note ? <Text style={[styles.muted, { paddingHorizontal: 4, paddingTop: 4 }]}>{note}</Text> : null}
        {settingsFailed ? <Text style={[styles.muted, { paddingHorizontal: 4, paddingTop: 4 }]}>{TURN_CARDS_SETTING_HINT}</Text> : null}
      </View>
    );
  };
}

const NOTHING_EXPANDED: ReadonlySet<string> = new Set();

function toggled(open: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(open);
  if (!next.delete(path)) next.add(path);
  return next;
}

function MoreInDocuments({ count, styles, theme, onPress }: { count: number; styles: Styles; theme: Theme; onPress(): void }) {
  return (
    <View style={{ flexDirection: "row", paddingHorizontal: 4, paddingTop: 4 }}>
      <ToolbarButton theme={theme} styles={styles} icon="FileText" label={`+${count} more in Documents`} onPress={onPress} />
    </View>
  );
}

export function legacyTurnDocsCard(Card: (props: PluginTimelineItemProps<TurnDocs>) => ReactElement) {
  return function TurnDocsCardV1(props: PluginTimelineItemProps<TurnDocsV1>) {
    return <Card {...props} item={{ ...props.item, data: upgradeTurnDocs(props.item.data) }} />;
  };
}

// Quiet on purpose: the card shows after every turn that changed documents. The visual box stays
// about one text line tall so the header keeps its height; the hit slop makes a 44 pt target on phones.
function SettingsLink({ theme, styles, onPress }: { theme: Theme; styles: Styles; onPress(): void }) {
  const color = theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings: show changed documents after each turn"
      accessibilityHint="Opens Settings, Document viewer, where these cards can be turned off"
      hitSlop={styles.compact ? 11 : 4}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 22,
        minWidth: 22,
        paddingHorizontal: 4,
        borderRadius: 6,
        justifyContent: "center",
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name="Settings" size={14} color={color} />
      {styles.compact ? null : <Text style={{ color, fontSize: 12 }}>Settings</Text>}
    </Pressable>
  );
}

function useCardThumbnails(client: CardClient, workspaceId: string, files: readonly TurnDocsFile[], listed: readonly TurnDocsFile[]): ThumbnailLoader | null {
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  const [priority] = useState(nextCardPriority);
  const identity = files.map((file) => `${file.path}\0${file.revision}`).join("\0");
  useEffect(() => {
    const next = createCardThumbnails(client, { workspaceId, files }, priority);
    const stop = next.subscribe(refresh);
    setLoader(next);
    return () => {
      stop();
      next.close();
    };
    // `identity` stands for `files`, which the host may hand over as a new array on every render.
  }, [workspaceId, identity]);
  const wanted = cardThumbnailIndices(files, listed);
  const wantedKey = wanted.join(",");
  useEffect(() => {
    loader?.want(wanted);
  }, [loader, wantedKey]);
  return loader;
}

function useOpenedRevisions(client: CardClient, workspaceId: string, listed: readonly TurnDocsFile[]): Readonly<Record<string, string>> {
  const [opened, setOpened] = useState<Readonly<Record<string, string>>>({});
  const paths = listed.map((file) => file.path);
  const identity = paths.join("\0");
  useEffect(() => watchOpenedRevisions(client, workspaceId, paths, setOpened), [workspaceId, identity]);
  return opened;
}

function FileThumbnail({ file, state, size, palette, theme }: { file: TurnDocsFile; state: ThumbnailState | undefined; size: number; palette: KindPalette; theme: Theme }) {
  const image = state?.status === "ready" && state.thumbnail.type === "image" ? state.thumbnail.image : null;
  return (
    <View style={{ width: size, height: size, borderRadius: 4, overflow: "hidden", alignItems: "center", justifyContent: "center",
      backgroundColor: image ? theme.colors.surface2 : "transparent" }}>
      {image ? (
        <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={{ width: size, height: size }} resizeMode="contain"
          accessible={false} />
      ) : (
        <Icon name={KIND_ICON[file.kind]} size={16} color={kindColor(palette, file.kind)} />
      )}
    </View>
  );
}

// A folder row holds only new files (turnDocsGroupSchema), so it always reads New.
function GroupRow({ group, open, size, styles, theme, onToggle }: {
  group: TurnDocsGroup; open: boolean; size: number; styles: Styles; theme: Theme; onToggle(): void;
}) {
  const folder = parentDir(group.path);
  const { detail, spoken } = TURN_GROUP[group.reason];
  // The name stays put when the row opens: aria-expanded says which it is, and the name holds the visible Show or Hide.
  const action = open ? "Hide" : "Show";
  return (
    <View
      accessible={false}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingVertical: styles.compact ? 4 : 3 }}
    >
      <View style={{ width: size, height: size, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
        <Icon name="Folder" size={16} color={theme.colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {`${baseName(group.path)}/`}
          </Text>
          <StatusPill theme={theme} styles={styles} status={TURN_FILE_PILL.new.status} label="short" />
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {folder ? `${folder} · ` : ""}
          {detail(group.count)}
        </Text>
      </View>
      <ToolbarButton
        theme={theme}
        styles={styles}
        icon={open ? "ChevronUp" : "ChevronDown"}
        label={action}
        accessibilityLabel={`Show or hide ${group.path}, ${spoken}, ${group.count} ${group.count === 1 ? "document" : "documents"}`}
        expanded={open}
        onPress={onToggle}
      />
    </View>
  );
}

function FileRow({ file, within, thumbnail, pill, palette, size, styles, theme, onOpen }: {
  file: TurnDocsFile; within: string; thumbnail: ThumbnailState | undefined; pill: TurnFilePill; palette: KindPalette; size: number; styles: Styles; theme: Theme; onOpen(): void;
}) {
  const folder = within ? parentDir(file.path.slice(within.length + 1)) : parentDir(file.path);
  const { status, spoken } = TURN_FILE_PILL[pill];
  return (
    <View
      accessible={false}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingVertical: styles.compact ? 4 : 3 }}
    >
      <FileThumbnail file={file} state={thumbnail} size={size} palette={palette} theme={theme} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {baseName(file.path)}
          </Text>
          <StatusPill theme={theme} styles={styles} status={status} label="short" />
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {folder ? `${folder} · ` : ""}
          {humanSize(file.size)}
        </Text>
      </View>
      <ToolbarButton
        theme={theme}
        styles={styles}
        label="Open"
        accessibilityLabel={`Open ${file.path}, ${KIND_LABEL[file.kind]}, ${spoken}`}
        onPress={onOpen}
      />
    </View>
  );
}

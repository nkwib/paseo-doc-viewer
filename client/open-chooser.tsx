import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { viewerSettingsRpc } from "../shared/settings";
import { type OpenPreference, openPreference, useOpenChoice } from "./open-target";
import type { Styles } from "./ui";

const SAVED_TEXT: { readonly [P in OpenPreference]: string } = {
  side: "Documents open side by side from now on.",
  full: "Documents open in their own tab from now on.",
  auto: "Documents open side by side on wide windows, in their own tab otherwise.",
};

// Asked once, on the first document opened on a wide layout; the answer is the Open documents setting.
export function OpenChooser({ theme, styles }: { theme: PluginTheme; styles: Styles }) {
  const read = useRpc(viewerSettingsRpc.read);
  const write = useRpc(viewerSettingsRpc.write);
  const choice = useOpenChoice(() => read({}));
  const [saved, setSaved] = useState<OpenPreference | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  if (saved === null && choice !== "unset") return null;
  const choose = async (value: OpenPreference) => {
    setSaving(true);
    const done = await openPreference.save(() => read({}), write, value).catch(() => false);
    setSaving(false);
    setSaved(done ? value : "failed");
  };
  const card = { margin: styles.gutter / 2, padding: 12, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 };
  if (saved !== null) {
    return (
      <View style={[card, { flexDirection: "row", alignItems: "center", gap: 8 }]} accessibilityLabel="Open documents choice">
        <Text style={[styles.muted, { flex: 1, fontSize: 13 }]}>
          {saved === "failed" ? "Could not save the choice. Set it in Settings, Document viewer." : `${SAVED_TEXT[saved]} Change it in Settings, Document viewer.`}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="OK" hitSlop={styles.hitSlop} onPress={() => setSaved(null)}
          style={{ paddingHorizontal: 10, height: styles.controlSize, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}>
          <Text style={[styles.text, { fontSize: 13 }]}>OK</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={card} accessibilityLabel="How should documents open?">
      <Text style={[styles.text, { fontWeight: "600" }]}>How should documents open?</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Choice theme={theme} styles={styles} label="Side by side" hint="Next to the chat" disabled={saving} onPress={() => void choose("side")}>
          <Mockup theme={theme} chat />
        </Choice>
        <Choice theme={theme} styles={styles} label="Full view" hint="In its own tab" disabled={saving} onPress={() => void choose("full")}>
          <Mockup theme={theme} chat={false} />
        </Choice>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Decide for me (Auto)" hitSlop={styles.hitSlop} disabled={saving} onPress={() => void choose("auto")}>
          <Text style={[styles.muted, { fontSize: 13, textDecorationLine: "underline" }]}>Decide for me (Auto)</Text>
        </Pressable>
        <Text style={styles.muted}>You can change it in Settings.</Text>
      </View>
    </View>
  );
}

function Choice({ theme, styles, label, hint, disabled, onPress, children }: {
  theme: PluginTheme; styles: Styles; label: string; hint: string; disabled: boolean; onPress(): void; children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${hint.toLowerCase()}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flex: 1,
        minWidth: 0,
        gap: 6,
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: hovered ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface0,
      })}
    >
      {children}
      <View>
        <Text style={[styles.text, { fontSize: 13, fontWeight: "600" }]} numberOfLines={1}>{label}</Text>
        <Text style={styles.muted} numberOfLines={1}>{hint}</Text>
      </View>
    </Pressable>
  );
}

// Drawn from theme colors, so it matches every theme: a chat column beside a document, or the document alone.
function Mockup({ theme, chat }: { theme: PluginTheme; chat: boolean }) {
  const c = theme.colors;
  const bar = (width: `${number}%`, color = c.border) => <View style={{ height: 3, width, borderRadius: 2, backgroundColor: color }} />;
  return (
    <View aria-hidden style={{ height: 56, flexDirection: "row", gap: 3, padding: 3, borderRadius: 6, backgroundColor: c.surface2 }}>
      {chat ? (
        <View style={{ flex: 3, justifyContent: "flex-end", gap: 4, padding: 4, borderRadius: 4, backgroundColor: c.surface1 }}>
          {bar("70%")}
          <View style={{ alignItems: "flex-end" }}>{bar("50%", c.foregroundMuted)}</View>
          {bar("85%")}
          <View style={{ height: 6, borderRadius: 3, borderWidth: 1, borderColor: c.border }} />
        </View>
      ) : null}
      <View style={{ flex: chat ? 2 : 1, alignItems: "center", justifyContent: "center", borderRadius: 4, backgroundColor: c.surface1 }}>
        <View style={{ width: chat ? "70%" : "40%", height: "84%", gap: 3, padding: 4, borderRadius: 2, backgroundColor: c.surface0 }}>
          {bar("60%", c.accent)}
          {bar("90%")}
          {bar("80%")}
          {bar("90%")}
        </View>
      </View>
    </View>
  );
}

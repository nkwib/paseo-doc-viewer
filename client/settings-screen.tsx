import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { turnCardsMode, viewerSettings, withTurnCardsMode, type TurnCardsMode } from "../shared/settings";
import { kindColorsSetting } from "./use-kind-colors";
import { OPEN_OPTIONS, openPreference, type OpenPreference } from "./open-target";
import { TURN_CARDS_HINT, TURN_CARDS_OPTIONS } from "./turn-docs";

export function ViewerSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(viewerSettings);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (settings.status === "loading") return <Text style={muted}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Agent turns">
        <Text style={muted}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  }
  const values = settings.values;
  const saveKindColors = async (kindColors: boolean) => {
    if (await settings.save({ ...values, kindColors }, settings.revision)) kindColorsSetting.set(kindColors);
  };
  const saveOpenDocuments = async (openDocuments: OpenPreference) => {
    if (await settings.save({ ...values, openDocuments }, settings.revision)) openPreference.set(openDocuments);
  };
  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Agent turns">
        <SettingsCard>
          <SettingsSelect
            label="Changed documents after each turn"
            hint={TURN_CARDS_HINT}
            value={turnCardsMode(values)}
            options={TURN_CARDS_OPTIONS}
            disabled={settings.saving}
            onValueChange={(mode: TurnCardsMode) => void settings.save(withTurnCardsMode(values, mode), settings.revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Documents">
        <SettingsCard>
          <SettingsSelect
            label="Open documents"
            hint="On a wide window. Side by side opens Documents next to the chat; Full view opens the standalone viewer. Auto picks side by side from 1,100 pt wide. A Documents panel already on screen always shows the document, and phones always use the standalone viewer."
            value={values.openDocuments ?? "auto"}
            options={OPEN_OPTIONS}
            disabled={settings.saving}
            onValueChange={(openDocuments: OpenPreference) => void saveOpenDocuments(openDocuments)}
          />
          <SettingsSwitch
            label="Color file types"
            hint="File icons take a color per type in Documents and turn cards. Off shows every icon in gray. Applies to every device on this host."
            value={values.kindColors}
            disabled={settings.saving}
            onValueChange={(kindColors: boolean) => void saveKindColors(kindColors)}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

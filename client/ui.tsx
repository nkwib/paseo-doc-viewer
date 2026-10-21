import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { describeError } from "./format";
import { canRetry } from "./paging";

// `compact` is the narrow arrangement (icon-only, wrapped toolbars); `touch` sizes the targets, so a
// narrow explorer column on a desktop keeps mouse-sized controls.
export function makeStyles(theme: PluginTheme, compact: boolean, bottomInset = 0, touch = compact) {
  const c = theme.colors;
  const gutter = compact ? 12 : 16;
  // Phones get 40 pt controls plus a 4 pt hit slop (44 pt targets); desktop keeps 28.
  const controlSize = touch ? 40 : 28;
  return {
    compact,
    touch,
    gutter,
    controlSize,
    hitSlop: touch ? 4 : undefined,
    inputHeight: touch ? 44 : 32,
    bottomInset,
    screen: { flex: 1, backgroundColor: c.surface0 },
    toolbar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: touch ? 48 : compact ? 36 : 44,
      paddingHorizontal: gutter,
      paddingVertical: compact ? 4 : 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface0,
    },
    toolbarSpacer: { flex: 1 },
    toolbarGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    // 104 lets ‹ label › fit a 230 pt explorer column; longer ranges wrap there.
    rangeLabel: { minWidth: compact ? 104 : 132, flexShrink: 1, textAlign: "center" as const },
    text: { color: c.foreground, fontSize: 14 },
    content: { color: c.foreground, fontSize: compact ? 16 : 15, lineHeight: compact ? 24 : 22 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    label: { color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    danger: { color: c.statusDanger, fontSize: 14 },
    centered: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      padding: 24,
    },
    stateTitle: { color: c.foreground, fontSize: 14, textAlign: "center" as const },
    stateDetail: { color: c.foregroundMuted, fontSize: 12, textAlign: "center" as const, maxWidth: 420 },
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 4,
      height: controlSize,
      minWidth: controlSize,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderStyle: "solid" as const,
      borderColor: c.border,
      backgroundColor: "transparent",
    },
    // Actions are outlined like the host's header buttons. Toggles sit flat until pressed on, then take a
    // neutral fill like the host's segmented controls. Accent marks the one primary action.
    buttonToggle: { borderColor: "transparent" },
    buttonHovered: { backgroundColor: c.surface1 },
    buttonToggleOn: { backgroundColor: c.surface2, borderColor: c.surface2 },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonText: { color: c.foreground, fontSize: 12 },
    buttonTextPrimary: { color: c.accentForeground },
    disabled: { opacity: 0.5 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1 },
  };
}

export type Styles = ReturnType<typeof makeStyles>;

interface ChromeProps {
  theme: PluginTheme;
  styles: Styles;
}

export function LoadingState({ theme, styles, label }: ChromeProps & { label?: string }) {
  return (
    <View style={styles.centered} accessibilityRole="progressbar" accessibilityLabel={label ?? "Loading"}>
      <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
      {label ? <Text style={styles.stateDetail}>{label}</Text> : null}
    </View>
  );
}

export function MessageState({
  theme,
  styles,
  icon,
  title,
  detail,
  tone = "muted",
  action,
  children,
}: ChromeProps & {
  icon: string;
  title: string;
  detail?: string;
  tone?: "muted" | "danger";
  action?: { label: string; onPress(): void };
  children?: ReactNode;
}) {
  const iconColor = tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={styles.centered} accessibilityRole={tone === "danger" ? "alert" : undefined}>
      <Icon name={icon} size={24} color={iconColor} />
      <Text style={styles.stateTitle}>{title}</Text>
      {detail ? (
        <Text style={styles.stateDetail} selectable>
          {detail}
        </Text>
      ) : null}
      {action || children ? (
        <View style={styles.toolbarGroup}>
          {action ? <ToolbarButton styles={styles} theme={theme} label={action.label} onPress={action.onPress} /> : null}
          {children}
        </View>
      ) : null}
    </View>
  );
}

export function ErrorState({ theme, styles, error, onRetry, children }: ChromeProps & { error: unknown; onRetry?: () => void; children?: ReactNode }) {
  const described = describeError(error);
  return (
    <MessageState
      theme={theme}
      styles={styles}
      icon={described.icon}
      title={described.title}
      detail={described.detail}
      tone={described.tone}
      action={onRetry && canRetry(error) ? { label: "Try again", onPress: onRetry } : undefined}
    >
      {children}
    </MessageState>
  );
}

export type ButtonVariant = { variant?: "default" | "primary" } | { variant: "toggle"; selected: boolean };

// Toggles set accessibilityState for native and aria-pressed for the web, like the host's own toggles:
// React Native Web 0.21 drops accessibilityState, and native React Native has no aria-pressed.
export function ToolbarButton({
  theme,
  styles,
  label,
  icon,
  onPress,
  disabled,
  accessibilityLabel,
  expanded,
  ...kind
}: ChromeProps & ButtonVariant & {
  label?: string;
  icon?: string;
  onPress(): void;
  disabled?: boolean;
  accessibilityLabel?: string;
  // For Show and Hide. Sent as aria-expanded: react-native-web drops accessibilityState, React Native reads either.
  expanded?: boolean;
}) {
  const primary = kind.variant === "primary";
  const toggle = kind.variant === "toggle" ? { on: kind.selected } : null;
  const color = primary ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled), ...(toggle ? { selected: toggle.on } : {}) }}
      aria-expanded={expanded}
      aria-pressed={toggle?.on}
      hitSlop={styles.hitSlop}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.button,
        primary ? styles.buttonPrimary : !toggle?.on && hovered && !disabled ? styles.buttonHovered : null,
        toggle ? (toggle.on ? styles.buttonToggleOn : styles.buttonToggle) : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      {label ? (
        <Text style={[styles.buttonText, primary ? styles.buttonTextPrimary : null]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

// A real checkbox: an icon and a plain label, no button fill.
export function Checkbox({ theme, styles, label, checked, disabled, onChange }: ChromeProps & {
  label: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      aria-checked={checked}
      hitSlop={styles.hitSlop}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[styles.button, styles.buttonToggle, { paddingHorizontal: 0 }, disabled ? styles.disabled : null]}
    >
      <Icon name={checked ? "SquareCheck" : "Square"} size={16} color={theme.colors.foreground} />
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const STATUS_PILL = {
  reviewed: { icon: "Check", label: "Reviewed", short: "Reviewed", tone: "statusSuccess" },
  changed: { icon: "TriangleAlert", label: "Changed since review", short: "Changed", tone: "statusWarning" },
  new: { icon: "Sparkles", label: "New", short: "New", tone: "accent" },
  modified: { icon: "Pencil", label: "Changed", short: "Changed", tone: "foregroundMuted" },
  opened: { icon: "Eye", label: "Opened", short: "Opened", tone: "foregroundMuted" },
} as const;

export type PillStatus = keyof typeof STATUS_PILL;

export function statusIcon(theme: PluginTheme, status: PillStatus): { name: string; color: string } {
  const pill = STATUS_PILL[status];
  return { name: pill.icon, color: theme.colors[pill.tone] };
}

// Review status as an icon and label on a tint of the status color. The tint is the color itself
// at low opacity, since the theme has no tinted tokens. The label stays in the foreground color:
// 12 px text in the status colors falls under 4.5:1 on several built-in themes.
export function StatusPill({ theme, styles, status, label = "full" }: ChromeProps & {
  status: PillStatus; label?: "full" | "short" | "none";
}) {
  const pill = STATUS_PILL[status];
  const color = theme.colors[pill.tone];
  const text = label === "full" ? pill.label : label === "short" ? pill.short : null;
  return (
    <View accessible accessibilityLabel={pill.label}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 22, minWidth: 22, paddingHorizontal: text ? 8 : 5, borderRadius: 11, overflow: "hidden", flexShrink: 0 }}>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: color, opacity: 0.14 }} />
      <Icon name={pill.icon} size={12} color={color} />
      {text ? <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }} numberOfLines={1}>{text}</Text> : null}
    </View>
  );
}

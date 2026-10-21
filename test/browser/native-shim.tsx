// Test-only DOM adapter. This exercises plugin components and RPCs, not Paseo's
// own React Native Web integration; desktop/native still require host smoke tests.
import React, { forwardRef, useEffect, useRef } from "react";
const flatten = (value: any): any => Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : value ?? {};
// React Native's axis shorthands are not CSS properties.
const AXES: Record<string, [string, string]> = { paddingHorizontal: ["paddingLeft", "paddingRight"], paddingVertical: ["paddingTop", "paddingBottom"], marginHorizontal: ["marginLeft", "marginRight"], marginVertical: ["marginTop", "marginBottom"] };
const css = (value: any) => { const result = { ...flatten(value) }; delete result.textAlignVertical;
  for (const [axis, [start, end]] of Object.entries(AXES)) if (axis in result) { result[start] ??= result[axis]; result[end] ??= result[axis]; delete result[axis]; } if (typeof result.lineHeight === "number") result.lineHeight = `${result.lineHeight}px`; return result; };
// The harness has no real layout pass: scroll frames report a fixed width, narrower in the ?compact phone layout.
const FRAME_WIDTH = new URLSearchParams(location.search).has("compact") ? 366 : 850;
export const Platform = { OS: "web", select: (value: any) => value.web ?? value.default };
export const StyleSheet = { create: (value: any) => value, flatten };
export const PixelRatio = { get: () => 1 };
export const Dimensions = { get: () => ({ width: 900, height: 700 }) };
export const TurboModuleRegistry = { get: () => null };
export const Keyboard = { addListener: () => ({ remove() {} }) };
// As in React Native Web: "change" follows the page's visibility.
export const AppState = { addEventListener: (_type: "change", handler: (state: "active" | "background") => void) => {
  const changed = () => handler(document.visibilityState === "hidden" ? "background" : "active");
  document.addEventListener("visibilitychange", changed);
  return { remove: () => document.removeEventListener("visibilitychange", changed) };
} };
export const useWindowDimensions = () => ({ width: 900, height: 700 });
// Views do not shrink by default in React Native, unlike CSS flex items.
export const View = forwardRef<any, any>(function View({ children, style, onLayout, accessibilityLabel, accessibilityRole, pointerEvents, "aria-hidden": ariaHidden, ...props }, ref) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = node.current;
    if (!onLayout || !element) return;
    const rect = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    onLayout({ nativeEvent: { layout: { x: rect.left - (parent?.left ?? 0), y: rect.top - (parent?.top ?? 0), width: rect.width, height: rect.height } } });
  });
  return <div ref={(value) => { node.current = value; if (value) { (value as any).measure = (callback: any) => callback(0, 0, FRAME_WIDTH, 540, 0, 0); (value as any).measureInWindow = (callback: any) => callback(0, 0, FRAME_WIDTH, 540); } if (typeof ref === "function") ref(value); else if (ref) ref.current = value; }}
    style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, flexShrink: 0, boxSizing: "border-box", position: "relative", pointerEvents, ...css(style) }} aria-label={accessibilityLabel} role={accessibilityRole} aria-hidden={ariaHidden || undefined}>{children}</div>;
});
// React Native Web 0.21's styles for numberOfLines: one line ends in an ellipsis, more lines clamp.
const ONE_LINE = { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", wordWrap: "normal" };
const lines = (count?: number) => count === 1 ? ONE_LINE
  : count && count > 1 ? { display: "-webkit-box", maxWidth: "100%", overflow: "clip", textOverflow: "ellipsis", WebkitBoxOrient: "vertical", WebkitLineClamp: count } : {};
export const Text = ({ children, style, accessibilityLabel, onPress, accessibilityRole, onLayout, numberOfLines }: any) => {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = node.current;
    if (!onLayout || !element?.parentElement) return;
    const y = element.getBoundingClientRect().top - element.parentElement.getBoundingClientRect().top;
    onLayout({ nativeEvent: { layout: { x: 0, y, width: element.offsetWidth, height: element.offsetHeight } } });
  });
  // React Native keeps line breaks in text.
  return <span ref={node} style={{ whiteSpace: "pre-wrap", ...lines(numberOfLines), ...css(style) }} aria-label={accessibilityLabel} onClick={onPress} role={accessibilityRole}>{children}</span>;
};
// A focusable div with the role. Like React Native Web 0.21, state reaches the DOM only through aria-* props
// (accessibilityState is ignored), `role` wins over accessibilityRole, and Enter presses but Space presses only a
// button: any other role takes Space through its own onKeyDown.
const CHECKED_ROLES = new Set(["radio", "checkbox"]);
export const Pressable = ({ children, style, accessibilityLabel, accessibilityRole, role, disabled, onPress, onKeyDown, "aria-pressed": pressed, "aria-checked": checked, "aria-expanded": expanded, "aria-current": current, "aria-level": level }: any) => {
  const checkable = CHECKED_ROLES.has(accessibilityRole);
  const domRole = role ?? (checkable ? accessibilityRole : "button");
  return <div role={domRole} tabIndex={disabled ? -1 : 0} aria-label={accessibilityLabel}
    aria-pressed={pressed} aria-checked={checked} aria-expanded={expanded} aria-current={current} aria-level={level} aria-disabled={disabled || undefined}
    onClick={disabled ? undefined : onPress}
    onKeyDown={(event) => { if (!disabled && (event.key === "Enter" || (event.key === " " && domRole === "button"))) { event.preventDefault(); onPress?.(); } onKeyDown?.(event); }}
    style={{ cursor: "pointer", boxSizing: "border-box", display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0, ...css(typeof style === "function" ? style({ pressed: false, hovered: false }) : style) }}>{children}</div>;
};
export const ScrollView = forwardRef<any, any>(function ScrollView({ children, style, contentContainerStyle, onLayout, onScroll, horizontal }: any, ref) {
  useEffect(() => { onLayout?.({ nativeEvent: { layout: { width: FRAME_WIDTH, height: 540, x: 0, y: 0 } } }); }, [onLayout]);
  // React Native's scrollTo takes { x, y }; the DOM method takes { left, top }.
  return <div ref={(value) => { if (value) (value as any).scrollTo = ({ x, y }: { x?: number; y?: number }) => { if (y !== undefined) value.scrollTop = y; if (x !== undefined) value.scrollLeft = x; }; if (typeof ref === "function") ref(value); else if (ref) ref.current = value; }}
    style={{ overflow: "auto", ...css(style) }} onScroll={onScroll ? (event) => onScroll({ nativeEvent: { contentOffset: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop } } }) : undefined}><div style={{ ...(horizontal ? { display: "flex", flexDirection: "row", width: "max-content" } : {}), ...css(contentContainerStyle) }}>{children}</div></div>;
});
export const TextInput = ({ value, onChangeText, onSubmitEditing, accessibilityLabel, style, placeholder, maxLength, autoFocus, multiline }: any) => multiline
  ? <textarea autoFocus={autoFocus} value={value} onChange={(event) => onChangeText(event.target.value)} aria-label={accessibilityLabel} style={css(style)} placeholder={placeholder} maxLength={maxLength} />
  : <input autoFocus={autoFocus} value={value} onChange={(event) => onChangeText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSubmitEditing?.(); }} aria-label={accessibilityLabel} style={css(style)} placeholder={placeholder} maxLength={maxLength} />;
export const Image = ({ source, style, accessibilityLabel, resizeMode }: any) => <img src={source.uri} style={{ objectFit: resizeMode === "contain" ? "contain" : undefined, ...css(style) }} alt={accessibilityLabel} />;
export const ActivityIndicator = ({ accessibilityLabel = "Loading" }: any) => <span aria-label={accessibilityLabel}>…</span>;
// A sticky header is position: sticky, as in React Native Web.
export const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, contentContainerStyle, stickyHeaderIndices, role, accessibilityLabel }: any) => <div role={role} aria-label={accessibilityLabel} style={{ overflow: "auto", ...css(contentContainerStyle) }}>
  {ListHeaderComponent ? <div style={stickyHeaderIndices?.includes(0) ? { position: "sticky", top: 0, zIndex: 10 } : undefined}>{ListHeaderComponent}</div> : null}
  {data.map((item: any, index: number) => <div key={keyExtractor?.(item, index) ?? index}>{renderItem({ item, index })}</div>)}{ListFooterComponent}</div>;
// Same box as the host icon at size 14, so toolbar widths match the app.
export const Icon = ({ name, size = 14, color }: any) => <span aria-hidden="true" data-icon={name} style={{ display: "inline-block", width: size, textAlign: "center", color }}>{({ Search: "⌕", Download: "↓", ChevronRight: "›", ChevronLeft: "‹", ChevronUp: "↑", ChevronDown: "↓", X: "×", RotateCcw: "↶" } as any)[name] ?? "•"}</span>;
export const copyText = (value: string) => navigator.clipboard.writeText(value);
export const useToast = () => ({ show() {}, error() {} });

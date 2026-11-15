import { createElement, type ReactNode, type ReactElement } from "react";
import { Platform, View } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const Blob: new (parts: readonly Uint8Array[], options: { type: string }) => object;
declare const URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void };

export const canPlayMedia = Platform.OS === "web";

declare const window: { addEventListener(type: "focus", listener: () => void): void; removeEventListener(type: "focus", listener: () => void): void };

// The host gives panels no focus event; on the web the window has one. Native apps report through AppState.
export function onWindowFocus(listener: () => void): () => void {
  if (Platform.OS !== "web") return () => {};
  window.addEventListener("focus", listener);
  return () => window.removeEventListener("focus", listener);
}

export type PinchWheel = { deltaY: number; x: number; y: number };
type WheelInput = { ctrlKey: boolean; deltaY: number; clientX: number; clientY: number; preventDefault(): void };
interface WheelTarget {
  addEventListener(type: "wheel", listener: (event: WheelInput) => void, options: { passive: false }): void;
  removeEventListener(type: "wheel", listener: (event: WheelInput) => void): void;
  getBoundingClientRect(): { left: number; top: number };
}

// Browsers report a trackpad pinch, like Ctrl with a mouse wheel, as a wheel event with ctrlKey set.
// React listens to wheel events passively, so this listener is added directly: it has to stop the
// page itself from zooming. `x` and `y` are relative to the element. Other wheel events still scroll.
export function onPinchWheel(target: unknown, listener: (wheel: PinchWheel) => boolean): () => void {
  if (Platform.OS !== "web" || !target) return () => {};
  const element = target as WheelTarget;
  const handle = (event: WheelInput) => {
    if (!event.ctrlKey) return;
    const rect = element.getBoundingClientRect();
    if (listener({ deltaY: event.deltaY, x: event.clientX - rect.left, y: event.clientY - rect.top })) event.preventDefault();
  };
  element.addEventListener("wheel", handle, { passive: false });
  return () => element.removeEventListener("wheel", handle);
}

export function createMediaUrl(parts: readonly Uint8Array[], mimeType: string): string | null {
  if (Platform.OS !== "web") return null;
  return URL.createObjectURL(new Blob(parts, { type: mimeType }));
}

export function revokeMediaUrl(url: string): void {
  if (Platform.OS !== "web") return;
  URL.revokeObjectURL(url);
}

export interface MediaElementProps {
  uri: string;
  label: string;
  background: string;
  colorScheme?: "light" | "dark";
  kind?: "video" | "audio";
  onError?: () => void;
  onAspectRatio?: (ratio: number) => void;
}

export function MediaElement({ uri, label, background, colorScheme, kind = "video", onError, onAspectRatio }: MediaElementProps): ReactElement | null {
  if (Platform.OS !== "web") return null;
  return createElement(kind, {
    src: uri,
    controls: true,
    onError,
    onLoadedMetadata: onAspectRatio ? (event: { currentTarget: { videoWidth?: number; videoHeight?: number } }) => {
      const { videoWidth = 0, videoHeight = 0 } = event.currentTarget;
      if (videoWidth > 0 && videoHeight > 0) onAspectRatio(videoWidth / videoHeight);
    } : undefined,
    preload: "metadata",
    playsInline: true,
    "aria-label": label,
    style: { width: "100%", height: kind === "audio" ? 54 : "100%", objectFit: "contain", backgroundColor: background, display: "block", colorScheme },
  });
}

export const canDownloadOriginal = Platform.OS === "web" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
// A plain link, so the browser saves the prepared file on a real user click; styled like the toolbar buttons.
export function DownloadLink({ uri, name, style, children }: { uri: string; name: string; style: object; children: ReactNode }): ReactElement | null {
  if (!canDownloadOriginal) return null;
  return createElement("a", {
    href: uri,
    download: name,
    "aria-label": "Save original file",
    style: { display: "flex", boxSizing: "border-box", textDecoration: "none", cursor: "pointer", ...style },
  }, children);
}

interface ScopeElement {
  parentElement: ScopeElement | null;
  scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number;
  tabIndex: number;
  hasAttribute(name: string): boolean;
  closest(selector: string): unknown;
  focus(options: { preventScroll: boolean }): void;
}
declare const getComputedStyle: (element: ScopeElement) => { overflowX: string; overflowY: string };

const scrolls = (element: ScopeElement) => {
  const style = getComputedStyle(element);
  return (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight)
    || (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth);
};

// Keyboard handling is scoped to this viewer, so other tabs retain their shortcuts.
// A click focuses the scroll area under the pointer, not the wrapper, so the
// keyboard keeps scrolling the content and the wrapper adds no tab stop.
export function FindScope({ children, onFind, enabled = true }: { children: ReactNode; onFind(): void; enabled?: boolean }): ReactElement {
  if (Platform.OS !== "web") return createElement(View, { style: { flex: 1 } }, children);
  return createElement("div", {
    style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
    onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (enabled && event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); onFind(); }
    },
    onMouseDown: (event: { target: ScopeElement; currentTarget: ScopeElement }) => {
      if (event.target.closest("input,textarea,button,a,audio,video,[role=button],[tabindex]")) return;
      let element: ScopeElement | null = event.target;
      while (element && element !== event.currentTarget && !scrolls(element)) element = element.parentElement;
      if (!element || element === event.currentTarget) return;
      if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
      element.focus({ preventScroll: true });
    },
  }, children);
}

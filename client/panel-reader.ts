// The document each workspace's Documents panel shows, kept per plugin client (one host) so it survives
// tab switches and unmounts, and set by the openers too. `siblings` is the encoded documentScreen param.
export interface PanelSelection {
  path: string;
  siblings?: string;
}

export function createPanelReader() {
  const selected = new Map<string, PanelSelection>();
  const listeners = new Set<() => void>();
  // Mounted Documents panels and their measured width. Paseo keeps background tabs mounted at width 0,
  // so a panel with a width is on screen: in the explorer, a split pane, or the active tab.
  const panels = new Map<object, { workspaceId: string; width: number }>();
  return {
    get: (workspaceId: string) => selected.get(workspaceId) ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(workspaceId: string, selection: PanelSelection | null) {
      if (selection === null) selected.delete(workspaceId);
      else selected.set(workspaceId, selection);
      for (const listener of listeners) listener();
    },
    measured(panel: object, workspaceId: string, width: number) {
      panels.set(panel, { workspaceId, width });
    },
    unmounted(panel: object) {
      panels.delete(panel);
    },
    visible: (workspaceId: string) => [...panels.values()].some((panel) => panel.workspaceId === workspaceId && panel.width > 0),
  };
}

export type PanelReader = ReturnType<typeof createPanelReader>;

export const DETAILS_FOLDER_MIN_WIDTH = 640;
// Narrower than this, as in the explorer or a split pane, the reader keeps one toolbar row with the rest behind More.
const READER_COMPACT_MAX_WIDTH = 480;

// The layout a reader of the measured width gets; 0 is not measured yet.
export function readerLayout<Layout extends { compact: boolean }>(layout: Layout, width: number): Layout {
  return width > 0 && width < READER_COMPACT_MAX_WIDTH ? { ...layout, compact: true } : layout;
}
const DETAILS_SIZE_MIN_WIDTH = 400;

export interface DetailsColumns {
  folder: "column" | "inline";
  size: boolean;
  time: "long" | "short";
  timeWidth: number;
  statusWidth: number;
  rowHeight: number;
  iconSize: number;
  nameSize: number;
}

export function detailsColumns(width: number, compact: boolean): DetailsColumns {
  if (compact) return { folder: "inline", size: false, time: "short", timeWidth: 80, statusWidth: 92, rowHeight: 44, iconSize: 16, nameSize: 14 };
  const wide = width >= DETAILS_FOLDER_MIN_WIDTH;
  return {
    folder: wide ? "column" : "inline",
    size: width >= DETAILS_SIZE_MIN_WIDTH,
    time: wide ? "long" : "short",
    timeWidth: wide ? 112 : 80,
    statusWidth: 92,
    rowHeight: 28,
    iconSize: 14,
    nameSize: 13,
  };
}

export const PREVIEWS_MIN_WIDTH = 240;
const LIST_PADDING = 8;
const PREVIEW_CELL = 140;
export const PREVIEW_CAPTION_HEIGHT = 44;
const MAX_PIXEL_RATIO = 2;

export interface PreviewGrid {
  columns: number;
  gap: number;
  cellWidth: number;
  frameSize: number;
  requestWidth: 160 | 240;
}

export function previewGrid(width: number, compact: boolean, pixelRatio: number): PreviewGrid | null {
  if (!compact && width < PREVIEWS_MIN_WIDTH) return null;
  const usable = Math.max(0, width - 2 * LIST_PADDING);
  const gap = compact ? 8 : 12;
  const columns = compact ? (usable >= 420 ? 3 : 2) : Math.max(2, Math.round((usable + gap) / (PREVIEW_CELL + gap)));
  const cellWidth = Math.max(1, Math.floor((usable - gap * (columns - 1)) / columns));
  const requestWidth = cellWidth * Math.min(pixelRatio, MAX_PIXEL_RATIO) <= 160 ? 160 : 240;
  return { columns, gap, cellWidth, frameSize: cellWidth, requestWidth };
}

export const TREE_MAX_INDENT_LEVELS = 6;
const TREE_SIZE_MIN_WIDTH = 360;
const TREE_FULL_STATUS_MIN_WIDTH = 640;

export interface TreeLayout {
  indent: number;
  rowHeight: number;
  iconSize: number;
  nameSize: number;
  size: boolean;
  status: "full" | "short" | "none";
  actionLabels: boolean;
}

export function treeLayout(width: number, compact: boolean): TreeLayout {
  const roomy = width === 0 || width >= TREE_SIZE_MIN_WIDTH;
  return {
    indent: compact ? 12 : 16,
    rowHeight: compact ? 44 : 28,
    iconSize: compact ? 16 : 14,
    nameSize: compact ? 14 : 13,
    size: roomy,
    status: !compact && width >= TREE_FULL_STATUS_MIN_WIDTH ? "full" : roomy ? "short" : "none",
    actionLabels: roomy,
  };
}

export const treeIndent = (layout: TreeLayout, depth: number) => Math.min(depth, TREE_MAX_INDENT_LEVELS) * layout.indent;

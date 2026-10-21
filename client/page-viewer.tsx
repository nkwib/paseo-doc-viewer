import type { SearchMatch, SearchNavigation } from "../shared/search";
import { activeInPart, Highlight } from "./highlight";
import { pageHighlights, type PageHighlight } from "./highlights";
import { layoutClass, zoomFor, type ViewerPosition } from "../shared/viewer-state";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, type ImageStyle, type LayoutChangeEvent, Platform, ScrollView, Text, View } from "react-native";
import { docPageRpc, docTextRpc, mediaChunkRpc, type DocPageOutput, type DocTextOutput } from "../shared/rpc";
import { type ImageAnimation, animationFormat, loadAnimation } from "./animation";
import {
  clampIndex,
  fitSize,
  imageFitWidth,
  nextZoomStep,
  omittedImagesNote,
  pageRequests,
  pageTextNote,
  previousZoomStep,
  retryPage,
  stripItems,
  zoomedText,
  zoomGroupWidth,
  zoomLabel,
} from "./paging";
import { PageMap } from "./page-map";
import { PageNavigation } from "./page-navigation";
import { animationQueryKey, pageQueryKey, textQueryKey } from "./queries";
import { ErrorState, LoadingState, type Styles, ToolbarButton } from "./ui";
import { useFitWidth } from "./use-fit-width";
import { usePinchZoom } from "./use-pinch-zoom";
import { NATIVE_MEDIA_REQUEST_BYTES, MEDIA_REQUEST_BYTES } from "./media";
import { TransferState } from "./transfer-state";

type EncodedImage = Extract<DocPageOutput, { kind: "pdf" }>["image"];

export interface PageViewerProps {
  pageMap?: { compact: boolean; onClose(): void } | null;
  navigation?: SearchNavigation | null;
  searchMatches?: SearchMatch[];
  initialPosition?: ViewerPosition | null;
  onPositionChange?: (position: ViewerPosition) => void;
  workspaceId: string;
  path: string;
  revision: string;
  kind: "pdf" | "pptx" | "image";
  count: number;
  password?: string;
  animation?: ImageAnimation;
  theme: PluginTheme;
  styles: Styles;
  onActivePage?: (index: number) => void;
}

const NOUN = { pdf: "Page", pptx: "Slide", image: "Image" } as const;
const ZOOM_LABEL_WIDTH = 44;
// An icon button is its 14 pt icon plus 8 pt padding per side, or the control size if larger.
const ICON_BUTTON_WIDTH = 30;
const IMAGE_LABEL_SPACE = 28;

function dataUri(image: EncodedImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function PageViewer({ workspaceId, path, revision, kind, count, password, animation, theme, styles, initialPosition, onPositionChange, navigation, searchMatches, pageMap, onActivePage }: PageViewerProps) {
  const fetchPage = useRpc(docPageRpc);
  const fetchText = useRpc(docTextRpc);
  const fetchChunk = useRpc(mediaChunkRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const initial = initialPosition?.type === "page" ? initialPosition : null;
  const [index, setIndex] = useState(initial?.index ?? 0);
  const layout = layoutClass(styles.compact);
  const [zoom, setZoom] = useState(initial ? zoomFor(initial, layout) : 1);
  const [showText, setShowText] = useState(initial?.text ?? false);
  // A PDF search result opens the page text without changing the remembered mode,
  // unless the match carries page boxes: then the page itself shows the highlight.
  const [searchText, setSearchText] = useState(false);
  const textMode = kind === "pdf" && (showText || searchText);
  useEffect(() => {
    if (navigation?.target.type !== "page") return;
    setIndex(navigation.target.index);
    if (kind === "pdf") setSearchText(!navigation.boxes?.length);
  }, [navigation, kind]);
  const { contentWidth, contentHeight, requestWidth, onLayout } = useFitWidth(styles.gutter * 2, kind === "pptx" ? 1 : zoom);

  const active = clampIndex(index, count);
  const requests = pageRequests(active, count);

  useEffect(() => { onActivePage?.(active); }, [active, onActivePage]);
  useEffect(() => { onPositionChange?.({ type: "page", index: active, zoom, text: showText, zooms: { [layout]: zoom } }); }, [active, zoom, showText, layout, onPositionChange]);

  useEffect(() => {
    if (active !== index) setIndex(active);
  }, [active, index]);

  const pageKey = (target: number) => pageQueryKey(workspaceId, path, revision, target, requestWidth);
  const page = useQuery({
    queryKey: pageKey(active),
    queryFn: () => fetchPage({ workspaceId, path, password, index: active, maxWidth: requestWidth ?? undefined }),
    enabled: requestWidth !== null && requests.current !== null && !textMode,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: retryPage,
  });
  const pageText = useQuery({
    queryKey: textQueryKey(workspaceId, path, revision, active),
    queryFn: () => fetchText({ workspaceId, path, password, index: active }),
    enabled: textMode && requests.current !== null,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: retryPage,
  });

  const animationMimeType = animation ? animationFormat(Platform.OS, animation.mimeType) : null;
  const [animationRequested, setAnimationRequested] = useState(true);
  const [animationProgress, setAnimationProgress] = useState({ loaded: 0, size: animation?.size ?? 0 });
  useEffect(() => { setAnimationRequested(true); setAnimationProgress({ loaded: 0, size: animation?.size ?? 0 }); }, [revision]);
  const motion = useQuery({
    queryKey: animationQueryKey(workspaceId, path, revision),
    queryFn: ({ signal }) => loadAnimation((range) => fetchChunk({ workspaceId, path, ...range, mimeType: animationMimeType ?? undefined }), revision, {
      signal,
      chunkBytes: Platform.OS === "web" ? MEDIA_REQUEST_BYTES : NATIVE_MEDIA_REQUEST_BYTES,
      onProgress: (progress) => { if (!signal.aborted) setAnimationProgress(progress); },
    }),
    enabled: animationMimeType !== null && animationRequested,
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    const next = requests.prefetch;
    if (requestWidth === null || next === null || textMode) return;
    void queryClient.prefetchQuery({
      queryKey: pageKey(next),
      queryFn: () => fetchPage({ workspaceId, path, password, index: next, maxWidth: requestWidth }),
      staleTime: Infinity,
      retry: retryPage,
    });
  }, [queryClient, fetchPage, workspaceId, path, password, revision, requests.prefetch, requestWidth, textMode]);

  const noun = NOUN[kind];
  const paged = count > 1;
  const zoomable = !textMode && (page.data?.kind !== "pptx" || page.data.images.length + page.data.texts.length > 0);
  const shownText = pageText.data?.index === active ? pageText.data : undefined;
  const copyable = shownText && shownText.text.trim() !== "" ? shownText.text : null;
  const copyPageText = () => {
    if (copyable === null) return;
    copyText(copyable).then(
      () => toast.show("Page text copied"),
      () => toast.error("Could not copy the page text"),
    );
  };
  const { zoomTo, frameProps, outerProps, panProps, bodyProps } = usePinchZoom(zoom, setZoom, zoomable && page.data !== undefined, styles.gutter);

  // Search matches on the page being shown; the selected one scrolls into view once per navigation,
  // measured from the rendered box itself so it works at any zoom.
  const highlights = kind === "pdf" ? pageHighlights(searchMatches ?? [], active, navigation ?? null) : undefined;
  const revealedNavigation = useRef(0);
  const revealMatch = (rect: { x: number; y: number }) => {
    const serial = navigation?.serial;
    if (serial === undefined || revealedNavigation.current === serial) return;
    revealedNavigation.current = serial;
    outerProps.ref.current?.scrollTo({ y: Math.max(0, rect.y - styles.gutter), animated: true });
    if (zoom > 1) panProps.ref.current?.scrollTo({ x: Math.max(0, rect.x - styles.gutter), animated: true });
  };

  if (pageMap && kind === "pdf" && count > 0) {
    return <PageMap workspaceId={workspaceId} path={path} password={password} revision={revision} count={count} active={active} compact={pageMap.compact}
      theme={theme} styles={styles} onClose={pageMap.onClose} onOpen={(target) => { setIndex(target); pageMap.onClose(); }} />;
  }

  return (
    <View style={styles.screen}>
      {count > 0 ? (
        <View style={[styles.toolbar, styles.compact ? { flexWrap: "wrap", rowGap: 4 } : null]}>
          {kind === "pdf" ? (
            <PageNavigation active={active} count={count} theme={theme} styles={styles} onChange={setIndex} />
          ) : paged ? (
            <PageStrip active={active} count={count} noun={noun} theme={theme} styles={styles} onChange={setIndex} />
          ) : null}
          <View style={styles.toolbarSpacer} />
          <View style={{ width: 16, alignItems: "center" }}>
            {(textMode ? pageText.isFetching : page.isFetching) ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          </View>
          {/* Phones drop Reset to keep 44 pt targets on one row; Fit and the page map cover it. */}
          {styles.compact ? null : <ToolbarButton theme={theme} styles={styles} icon="RotateCcw" accessibilityLabel="Reset reading position"
            onPress={() => { setIndex(0); setZoom(1); setShowText(false); setSearchText(false); }} />}
          {kind === "pdf" ? (
            <ToolbarButton
              theme={theme}
              styles={styles}
              icon="FileText"
              accessibilityLabel={textMode ? "Show page image" : "Show page text"}
              variant="toggle"
              selected={textMode}
              onPress={() => { setShowText(!textMode); setSearchText(false); }}
            />
          ) : null}
          <View
            style={[
              styles.toolbarGroup,
              { width: zoomGroupWidth({ button: Math.max(ICON_BUTTON_WIDTH, styles.controlSize), label: ZOOM_LABEL_WIDTH, gap: styles.compact ? 4 : 8 }),
                gap: styles.compact ? 4 : 8, justifyContent: "flex-end" },
            ]}
          >
            {textMode ? (
              <ToolbarButton
                theme={theme}
                styles={styles}
                icon="Copy"
                accessibilityLabel="Copy page text"
                disabled={copyable === null}
                onPress={copyPageText}
              />
            ) : (
              <>
                <ToolbarButton
                  theme={theme}
                  styles={styles}
                  icon="ZoomOut"
                  accessibilityLabel="Zoom out"
                  disabled={!zoomable || zoom === 1}
                  onPress={() => zoomTo(previousZoomStep(zoom))}
                />
                <View style={{ width: ZOOM_LABEL_WIDTH }}>
                  <ToolbarButton
                    theme={theme}
                    styles={styles}
                    label={zoomLabel(zoom)}
                    accessibilityLabel="Fit to width"
                    disabled={!zoomable || zoom === 1}
                    onPress={() => zoomTo(1)}
                  />
                </View>
                <ToolbarButton
                  theme={theme}
                  styles={styles}
                  icon="ZoomIn"
                  accessibilityLabel="Zoom in"
                  disabled={!zoomable || zoom === nextZoomStep(zoom)}
                  onPress={() => zoomTo(nextZoomStep(zoom))}
                />
              </>
            )}
          </View>
        </View>
      ) : null}
      {animationMimeType && motion.isFetching ? <TransferState compact theme={theme} styles={styles} title="Loading animation"
        loaded={animationProgress.loaded} size={animationProgress.size}
        onCancel={() => {
          setAnimationRequested(false);
          void queryClient.cancelQueries({ queryKey: animationQueryKey(workspaceId, path, revision) });
        }} /> : null}
      {animationMimeType && !motion.isFetching && !motion.data && (!animationRequested || motion.error) ? <View style={{ padding: styles.gutter, gap: 4 }}>
        {motion.error ? <Text style={styles.danger} accessibilityRole="alert">Could not load the animation. The first frame is still available.</Text> : null}
        <ToolbarButton theme={theme} styles={styles} label="Load animation" onPress={() => {
          if (animationRequested) void motion.refetch();
          else setAnimationRequested(true);
        }} />
      </View> : null}
      <View {...frameProps}>
        <ScrollView {...outerProps} style={{ flex: 1 }} contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.gutter + styles.bottomInset, flexGrow: 1 }} onLayout={onLayout}>
          {count === 0 ? (
            <Text style={[styles.muted, { textAlign: "center" }]}>This document has no {noun.toLowerCase()}s</Text>
          ) : textMode ? (
            pageText.error && !shownText ? (
              <ErrorState theme={theme} styles={styles} error={pageText.error} onRetry={() => void pageText.refetch()} />
            ) : !shownText ? (
              <LoadingState theme={theme} styles={styles} />
            ) : (
              <PageText page={shownText} width={contentWidth} styles={styles} theme={theme} query={navigation?.query}
                active={navigation?.target.type === "page" && navigation.target.index === active ? navigation : undefined}
                onReveal={(y) => outerProps.ref.current?.scrollTo({ y: Math.max(0, y - styles.gutter * 2), animated: true })} />
            )
          ) : page.error && !page.data ? (
            <ErrorState theme={theme} styles={styles} error={page.error} onRetry={() => void page.refetch()} />
          ) : !page.data ? (
            <LoadingState theme={theme} styles={styles} />
          ) : (
            <ScrollView {...panProps} horizontal showsHorizontalScrollIndicator={zoom > 1}>
              <View {...bodyProps}>
                <PageBody page={page.data} animationUri={motion.data} contentWidth={contentWidth} contentHeight={contentHeight} zoom={zoom} theme={theme} styles={styles} noun={noun} query={navigation?.query}
                  active={navigation?.target.type === "page" && navigation.target.index === active ? navigation.start : undefined}
                  highlights={page.data.kind === "pdf" && page.data.index === active ? highlights : undefined}
                  onRevealMatch={navigation?.boxes?.length ? revealMatch : undefined} />
              </View>
            </ScrollView>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// Phones show `< n / N >`. Wider layouts keep the page chips between previous and next, and scroll the
// current chip into view.
function PageStrip({ active, count, noun, theme, styles, onChange }: {
  active: number; count: number; noun: string; theme: PluginTheme; styles: Styles; onChange(index: number): void;
}) {
  const strip = useRef<ScrollView>(null);
  const offsets = useRef(new Map<number, number>());
  const reveal = (x: number | undefined) => { if (x !== undefined) strip.current?.scrollTo({ x: Math.max(0, x - 48), animated: true }); };
  useEffect(() => { reveal(offsets.current.get(active)); }, [active]);
  const label = `${active + 1} / ${count}`;
  const lower = noun.toLowerCase();
  const previous = <ToolbarButton theme={theme} styles={styles} icon="ChevronLeft" accessibilityLabel={`Previous ${lower}`} disabled={active === 0} onPress={() => onChange(active - 1)} />;
  const next = <ToolbarButton theme={theme} styles={styles} icon="ChevronRight" accessibilityLabel={`Next ${lower}`} disabled={active >= count - 1} onPress={() => onChange(active + 1)} />;
  if (styles.compact) {
    return (
      <View style={[styles.toolbarGroup, { gap: 4 }]}>
        {previous}
        <View style={{ minWidth: 44, alignItems: "center" }}><Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text></View>
        {next}
      </View>
    );
  }
  return (
    <>
      <View style={[styles.toolbarGroup, { flexShrink: 1, minWidth: 0, gap: 4 }]}>
        {previous}
        <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 4, alignItems: "center" }}>
          {stripItems(active, count).map((item) =>
            item.type === "gap" ? (
              <Text key={`gap-${item.after}`} style={styles.label}>
                ...
              </Text>
            ) : (
              <View key={item.index} onLayout={(event: LayoutChangeEvent) => {
                offsets.current.set(item.index, event.nativeEvent.layout.x);
                if (item.index === active) reveal(event.nativeEvent.layout.x);
              }}>
                <ToolbarButton theme={theme} styles={styles} label={String(item.index + 1)} accessibilityLabel={`${noun} ${item.index + 1}`}
                  variant="toggle" selected={item.index === active} onPress={() => onChange(item.index)} />
              </View>
            ),
          )}
        </ScrollView>
        {next}
      </View>
      <Text style={styles.label}>{label}</Text>
    </>
  );
}

// The text is split at the line holding the selected match, so its offset can be measured
// and scrolled into view; nested Text spans report no layout of their own.
function PageText({ page, width, styles, theme, query, active, onReveal }: {
  page: DocTextOutput; width: number; styles: Styles; theme: PluginTheme; query?: string; active?: SearchNavigation; onReveal(y: number): void;
}) {
  const note = pageTextNote(page);
  const start = active && active.start < page.text.length ? active.start : undefined;
  const lineStart = start === undefined ? page.text.length : page.text.lastIndexOf("\n", start) + 1;
  const offsets = useRef({ root: 0, body: 0 });
  const revealed = useRef(-1);
  const reveal = (y: number) => {
    if (!active || revealed.current === active.serial) return;
    revealed.current = active.serial;
    onReveal(offsets.current.root + offsets.current.body + y);
  };
  return (
    <View style={{ gap: 12, maxWidth: width }} onLayout={(event) => { offsets.current.root = event.nativeEvent.layout.y; }}>
      {note ? <Text style={styles.muted}>{note}</Text> : null}
      {page.text.trim() === "" ? null : (
        <View onLayout={(event) => { offsets.current.body = event.nativeEvent.layout.y; }}>
          {lineStart > 0 ? (
            <Text style={styles.content} selectable>
              <Highlight text={page.text.slice(0, lineStart)} query={query} theme={theme} />
            </Text>
          ) : null}
          {start !== undefined ? (
            <Text key={active!.serial} style={styles.content} selectable onLayout={(event) => reveal(event.nativeEvent.layout.y)}>
              <Highlight text={page.text.slice(lineStart)} query={query} theme={theme} active={start - lineStart} />
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const PageBody = memo(function PageBody({
  page,
  animationUri,
  contentWidth,
  contentHeight,
  zoom,
  theme,
  styles,
  noun,
  query,
  active,
  highlights,
  onRevealMatch,
}: {
  page: DocPageOutput;
  animationUri?: string;
  contentWidth: number;
  contentHeight: number;
  zoom: number;
  theme: PluginTheme;
  styles: Styles;
  noun: string;
  query?: string;
  active?: number;
  highlights?: PageHighlight[];
  onRevealMatch?: (rect: { x: number; y: number }) => void;
}) {
  const zoomed = (width: number) => Math.round(width * zoom);
  if (page.kind === "pdf") {
    const frame = fitSize(zoomed(contentWidth), page.image);
    if (frame.width === 0) return null;
    return (
      <View style={[frame, { position: "relative", borderWidth: 1, borderColor: theme.colors.border }]}>
        <Image source={{ uri: dataUri(page.image) }} style={frame} resizeMode="contain" accessibilityLabel={`${noun} ${page.index + 1}`} />
        {(highlights ?? []).map((highlight, index) =>
          highlight.boxes.map((box, line) => (
            <View
              key={`${index}-${line}`}
              pointerEvents="none"
              accessibilityLabel={highlight.selected ? "Current match on page" : "Match on page"}
              onLayout={highlight.selected && line === 0 ? (event: LayoutChangeEvent) => onRevealMatch?.({ x: event.nativeEvent.layout.x, y: event.nativeEvent.layout.y }) : undefined}
              style={{
                position: "absolute",
                left: box.x * frame.width,
                top: box.y * frame.height,
                width: box.width * frame.width,
                height: box.height * frame.height,
                backgroundColor: theme.colors.accent,
                opacity: highlight.selected ? 0.45 : 0.28,
              }}
            />
          )),
        )}
        {/* The current match also gets a solid outline, so it stands out from the other matches. */}
        {(highlights ?? []).filter((highlight) => highlight.selected).map((highlight, index) =>
          highlight.boxes.map((box, line) => (
            <View key={`current-${index}-${line}`} pointerEvents="none" style={{
              position: "absolute",
              left: box.x * frame.width - 2,
              top: box.y * frame.height - 2,
              width: box.width * frame.width + 4,
              height: box.height * frame.height + 4,
              borderWidth: 2,
              borderRadius: 2,
              borderColor: theme.colors.accent,
            }} />
          )),
        )}
      </View>
    );
  }
  if (page.kind === "pptx") {
    const omitted = omittedImagesNote(page.omittedImages);
    const widths = page.images.map((image) => zoomed(Math.min(contentWidth, image.width)));
    const textStyle = zoomedText(styles.content, contentWidth, zoom);
    return (
      <View style={{ gap: 16 * zoom, width: Math.max(contentWidth, textStyle.maxWidth, ...widths) }}>
        {page.texts.length === 0 && page.images.length === 0 ? (
          <Text style={styles.muted}>This slide has no text or images</Text>
        ) : null}
        {page.texts.map((text, position) => (
          <Text
            key={`text-${position}`}
            style={[styles.content, textStyle, position === 0 ? { fontWeight: "500" } : null]}
            selectable
          >
            <Highlight text={text} query={query} theme={theme} active={activeInPart(page.texts, position, active)} />
          </Text>
        ))}
        {page.images.map((image, position) => (
          <FittedImage
            key={`image-${position}`}
            image={image}
            width={widths[position]!}
            label={`Slide ${page.index + 1} image ${position + 1}`}
          />
        ))}
        {omitted ? <Text style={styles.muted}>{omitted}</Text> : null}
      </View>
    );
  }
  const source = { width: page.sourceWidth, height: page.sourceHeight };
  const width = zoomed(imageFitWidth({ panelWidth: contentWidth, panelHeight: contentHeight - IMAGE_LABEL_SPACE - styles.bottomInset, source }));
  return (
    <View style={{ alignItems: "center", gap: 8, width: Math.max(contentWidth, width) }}>
      <FittedImage image={page.image} uri={animationUri} width={width} label="Image" />
      <Text style={[styles.label, { color: theme.colors.foregroundMuted }]}>
        {page.sourceWidth} x {page.sourceHeight}
      </Text>
    </View>
  );
});

function FittedImage({
  image,
  uri,
  width,
  label,
  style,
}: {
  image: EncodedImage;
  uri?: string;
  width: number;
  label: string;
  style?: ImageStyle;
}) {
  const size = fitSize(width, image);
  if (size.width === 0) return null;
  return <Image source={{ uri: uri ?? dataUri(image) }} style={[size, style]} resizeMode="contain" accessibilityLabel={label} />;
}

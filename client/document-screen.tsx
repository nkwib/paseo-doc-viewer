import type { SearchMatch, SearchNavigation } from "../shared/search";
import { FindPanel } from "./find-panel";
import { FindScope } from "./web";
import { DownloadOriginal } from "./download-original";
import { type PluginOpenScreenInput, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { docOpenRpc, type DocOpenOutput } from "../shared/rpc";
import { BlocksViewer } from "./blocks-viewer";
import { originalReachable } from "./format";
import { PageViewer } from "./page-viewer";
import { passwordPrompt } from "./password";
import { PasswordPrompt } from "./password-prompt";
import { documentQueryOptions } from "./queries";
import { SheetViewer } from "./sheet-viewer";
import { ErrorState, LoadingState, makeStyles, MessageState, StatusPill, type Styles, ToolbarButton } from "./ui";
import { useBottomInset } from "./use-bottom-inset";
import { useViewerPosition } from "./use-viewer-position";
import { useOpenedMark, useViewerMarks } from "./use-viewer-marks";
import { type DocumentReview, reviewStatus } from "./review";
import { MediaViewer } from "./media-viewer";
import { kindForPath } from "../shared/kinds";
import { openHostScreen } from "./host-client";
import { documentScreen } from "./recent";
import { parseSiblings, type SiblingPosition, siblingPosition } from "./siblings";
import { reviewDrafts, reviewScope, useReviewDraft } from "./review-draft";
import { NoteComposer, reviewScreen } from "./review-note";
import { OpenChooser } from "./open-chooser";

// The Documents panel embeds this screen and passes its own opener, so stepping stays in the panel.
// `phone` is the host's layout; the panel passes a compact layout for its narrow widths too.
// A Paseo file tab passes `chooser={false}`: Paseo opened the file, so how documents open does not apply.
export function DocumentScreen({ host, theme, layout, params, openDocument: open = openHostScreen, phone = layout.compact, chooser = true }: Pick<PluginScreenProps, "host" | "theme" | "layout" | "params"> & {
  openDocument?: (input: PluginOpenScreenInput) => void;
  phone?: boolean;
  chooser?: boolean;
}) {
  const { ref, onLayout, bottomInset } = useBottomInset();
  const styles = useMemo(() => makeStyles(theme, layout.compact, bottomInset, phone), [theme, layout.compact, bottomInset, phone]);
  const workspaceId = params.workspaceId ?? "";
  const path = params.path ?? "";
  const documentKey = `${workspaceId}\0${path}`;
  const siblings = useMemo(() => parseSiblings(params.siblings), [params.siblings]);
  const position = siblingPosition(siblings, path);
  const stepper = position && siblings ? (
    <SiblingStepper position={position} theme={theme} styles={styles} onOpen={(next) => open(documentScreen(workspaceId, next, siblings))} />
  ) : null;
  const [unlock, setUnlock] = useState<{ documentKey: string; password: string; attempt: number } | null>(null);
  const unlocked = unlock?.documentKey === documentKey ? unlock : null;
  const password = unlocked?.password;
  const openDocument = useRpc(docOpenRpc);
  const opened = useQuery({
    ...documentQueryOptions(workspaceId, path, unlocked?.attempt ?? 0),
    queryFn: () => openDocument({ workspaceId, path, password }),
    retry: false,
  });
  const prompt = passwordPrompt(opened.error);
  const checking = unlocked !== null && opened.status === "pending";
  // A renamed or deleted file must not keep showing its cached pages.
  const gone = opened.error !== null && !originalReachable(opened.error);
  // The original stays downloadable when the preview cannot open.
  const download = workspaceId && kindForPath(path) ? <DownloadOriginal key={documentKey} workspaceId={workspaceId} path={path} theme={theme} styles={styles} standalone /> : null;

  let body: ReactNode;
  if (!workspaceId || !path) {
    body = (
      <View style={styles.screen}>
        <MessageState theme={theme} styles={styles} icon="FileX" title="No document selected" />
      </View>
    );
  } else if (!opened.data && (prompt || checking)) {
    body = (
      <View style={styles.screen}>
        {stepper ? <View style={styles.toolbar}>{stepper}</View> : null}
        <PasswordPrompt
          theme={theme}
          styles={styles}
          compact={layout.compact}
          incorrect={prompt?.incorrect ?? false}
          busy={checking}
          onSubmit={(value) => setUnlock({ documentKey, password: value, attempt: (unlocked?.attempt ?? 0) + 1 })}
        >
          {download}
        </PasswordPrompt>
      </View>
    );
  } else if (!opened.data || gone) {
    body = (
      <View style={styles.screen}>
        {stepper ? <View style={styles.toolbar}>{stepper}</View> : null}
        {opened.error ? (
          <ErrorState theme={theme} styles={styles} error={opened.error} onRetry={() => void opened.refetch()}>
            {originalReachable(opened.error) ? download : null}
          </ErrorState>
        ) : (
          <LoadingState theme={theme} styles={styles} />
        )}
      </View>
    );
  } else {
    body = (
      <DocumentBody key={documentKey} document={opened.data} workspaceId={workspaceId} path={path} password={password} compact={layout.compact}
        reviewScope={reviewScope(host?.id, workspaceId)} stepper={stepper} theme={theme} styles={styles} />
    );
  }
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
      {phone || !chooser ? null : <OpenChooser theme={theme} styles={styles} />}
      {body}
    </View>
  );
}

function ViewerContent({
  document,
  workspaceId,
  path,
  password,
  theme,
  styles,
  navigation,
  searchMatches,
  pageMap,
  onActivePage,
}: {
  navigation?: SearchNavigation | null;
  searchMatches?: SearchMatch[];
  pageMap?: { compact: boolean; onClose(): void } | null;
  compact: boolean;
  onActivePage?: (index: number) => void;
  document: DocOpenOutput;
  workspaceId: string;
  path: string;
  password?: string;
  theme: PluginScreenProps["theme"];
  styles: Styles;
}) {
  const position = useViewerPosition(workspaceId, path);
  const remembers = ["pdf", "pptx", "image-raster", "image-decoded", "xlsx", "csv", "jsonl", "parquet"].includes(document.kind);
  if (remembers && !position.ready) return <LoadingState theme={theme} styles={styles} />;
  const common = { workspaceId, path, revision: document.revision, theme, styles, navigation };
  const remembered = { initialPosition: position.initial, onPositionChange: position.save };
  const key = `${workspaceId}\0${path}`;
  switch (document.kind) {
    case "pdf":
      return <PageViewer key={key} {...common} {...remembered} kind="pdf" count={document.pageCount} password={password} searchMatches={searchMatches} pageMap={pageMap} onActivePage={onActivePage} />;
    case "pptx":
      return <PageViewer key={key} {...common} {...remembered} kind="pptx" count={document.slideCount} />;
    case "image-raster":
    case "image-decoded":
      return <PageViewer key={key} {...common} {...remembered} kind="image" count={1} animation={document.animation} />;
    case "docx":
      return <BlocksViewer key={key} {...common} />;
    case "xlsx":
    case "csv":
    case "jsonl":
    case "parquet":
      return <SheetViewer key={key} {...common} {...remembered} kind={document.kind} sheets={document.sheets} />;
    case "video":
    case "audio":
      return <MediaViewer key={key} {...common} kind={document.kind} mimeType={document.mimeType} size={document.size} />;
  }
}

function DocumentBody({ reviewScope: scope, stepper, ...props }: Parameters<typeof ViewerContent>[0] & { reviewScope: string; stepper: ReactNode }) {
  const [finding, setFinding] = useState(false);
  // A note being typed when the viewer was unmounted (for example by a workspace switch) reopens.
  const [notePage, setNotePage] = useState<number | null>(() => {
    const kept = reviewDrafts.composing(scope, props.path);
    return kept && props.document.kind === "pdf" && kept.page < props.document.pageCount ? kept.page : null;
  });
  const shownRevision = useRef(props.document.revision);
  const draft = useReviewDraft(scope);
  const marks = useViewerMarks(props.workspaceId, props.path);
  useOpenedMark(props.workspaceId, props.path, props.document.revision);
  const review = reviewStatus(marks.review, props.document.revision);
  const [navigation, setNavigation] = useState<SearchNavigation | null>(null);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [activePage, setActivePage] = useState(0);
  useEffect(() => {
    if (shownRevision.current === props.document.revision) return;
    shownRevision.current = props.document.revision;
    setNavigation(null); setSearchMatches([]); setNotePage(null);
  }, [props.document.revision]);
  useEffect(() => { if (navigation) setMapOpen(false); }, [navigation]);
  const searchable = ["pdf", "docx", "xlsx", "csv", "jsonl", "parquet", "pptx"].includes(props.document.kind);
  // Page map and review notes act on a PDF page, so both need at least one.
  const paged = props.document.kind === "pdf" && props.document.pageCount > 0;
  const pageMap = useMemo(() => (mapOpen ? { compact: props.compact, onClose: () => setMapOpen(false) } : null), [mapOpen, props.compact]);
  // Narrow readers keep one row: the stepper, Find and status, with the other tools behind More.
  // A phone without a stepper fits them all, so it keeps them on the row.
  const overflow = props.compact && (stepper !== null || !props.styles.touch);
  const labels = !props.compact || moreOpen;
  const tools = <>
    {paged ? <ToolbarButton theme={props.theme} styles={props.styles} icon="LayoutGrid" label={labels ? "Pages" : undefined} accessibilityLabel="Page map"
      variant="toggle" selected={mapOpen} onPress={() => setMapOpen(!mapOpen)} /> : null}
    {paged ? <ToolbarButton theme={props.theme} styles={props.styles} icon="MessageSquarePlus" label={labels ? "Add note" : undefined}
      accessibilityLabel={`Add note to page ${activePage + 1}`} variant="toggle" selected={notePage !== null} onPress={() => setNotePage(notePage === null ? activePage : null)} /> : null}
    {draft.notes.length > 0 ? <ToolbarButton theme={props.theme} styles={props.styles} icon="ClipboardList"
      label={labels ? `Review (${draft.notes.length})` : String(draft.notes.length)}
      accessibilityLabel={`Review notes (${draft.notes.length})`} onPress={() => openHostScreen(reviewScreen(props.workspaceId))} /> : null}
    {marks.ready ? <MarkReviewed marks={marks} status={review} revision={props.document.revision} labeled={labels} theme={props.theme} styles={props.styles} /> : null}
    <DownloadOriginal workspaceId={props.workspaceId} path={props.path} theme={props.theme} styles={props.styles} labeled={labels} />
  </>;
  return <FindScope enabled={searchable} onFind={() => { if (searchable) setFinding(true); }}>
    <View style={props.styles.screen}>
    <View style={[props.styles.toolbar, { flexWrap: "wrap", rowGap: 4 }]}>
      {props.compact && !overflow ? null : stepper}
      {searchable ? <ToolbarButton theme={props.theme} styles={props.styles} icon="Search" label={props.compact ? undefined : "Find in document"} accessibilityLabel="Find in document"
        variant="toggle" selected={finding} onPress={() => { setFinding(!finding); if (finding) { setNavigation(null); setSearchMatches([]); } }} /> : null}
      {/* Status sits left of the spacer, so it appearing never moves the buttons. */}
      {marks.ready && review !== "never" ? <StatusPill theme={props.theme} styles={props.styles} status={review} label={props.compact ? "none" : "full"} /> : null}
      <View style={props.styles.toolbarSpacer} />
      {overflow ? <ToolbarButton theme={props.theme} styles={props.styles} icon="Ellipsis" accessibilityLabel="More actions" variant="toggle" selected={moreOpen}
        onPress={() => setMoreOpen(!moreOpen)} /> : <View style={[props.styles.toolbarGroup, { marginLeft: "auto", flexShrink: 1, minWidth: 0, flexWrap: "wrap", justifyContent: "flex-end", rowGap: 4 }]}>{tools}</View>}
    </View>
    {overflow && moreOpen ? <View style={[props.styles.toolbar, { flexWrap: "wrap", rowGap: 4 }]} accessibilityLabel="More actions">{tools}</View> : null}
    {props.compact && !overflow && stepper ? <View style={props.styles.toolbar}>{stepper}</View> : null}
    {notePage !== null ? <NoteComposer key={notePage} scope={scope} workspaceId={props.workspaceId} path={props.path} revision={props.document.revision}
      page={notePage} password={props.password} draft={draft} theme={props.theme} styles={props.styles} onClose={() => setNotePage(null)} /> : null}
    {finding ? <FindPanel key={props.document.revision} workspaceId={props.workspaceId} path={props.path} password={props.password}
      revision={props.document.revision} pageLabel={props.document.kind === "pptx" ? "Slide" : "Page"} theme={props.theme} styles={props.styles} onNavigate={setNavigation}
      onMatches={setSearchMatches}
      onClose={() => { setFinding(false); setNavigation(null); setSearchMatches([]); }} /> : null}
    <ViewerContent {...props} navigation={navigation} searchMatches={searchMatches} pageMap={pageMap} onActivePage={paged ? setActivePage : undefined} />
  </View></FindScope>;
}

// Marking reviewed is always an explicit press, for the revision on screen; opening or scrolling never does it.
// The name stays the same, so screen readers hear whether the file is reviewed once, as the pressed state.
function MarkReviewed({ marks, status, revision, labeled, theme, styles }: {
  marks: ReturnType<typeof useViewerMarks>; status: DocumentReview; revision: string; labeled: boolean; theme: PluginScreenProps["theme"]; styles: Styles;
}) {
  const reviewed = status === "reviewed";
  return <ToolbarButton theme={theme} styles={styles} icon="Check" label={labeled ? "Mark reviewed" : undefined}
    accessibilityLabel="Mark reviewed" variant="toggle" selected={reviewed}
    disabled={marks.saving} onPress={() => void marks.setReview(reviewed ? null : revision)} />;
}

function SiblingStepper({ position, theme, styles, onOpen }: {
  position: SiblingPosition; theme: PluginScreenProps["theme"]; styles: Styles; onOpen(path: string): void;
}) {
  const { previous, next } = position;
  return <View style={[styles.toolbarGroup, { gap: 4 }]}>
    <ToolbarButton theme={theme} styles={styles} icon="ChevronLeft" accessibilityLabel="Previous document" disabled={previous === null}
      onPress={() => { if (previous !== null) onOpen(previous); }} />
    <Text style={styles.label} accessibilityLabel={`Document ${position.index + 1} of ${position.count}`}>Document {position.index + 1} of {position.count}</Text>
    <ToolbarButton theme={theme} styles={styles} icon="ChevronRight" accessibilityLabel="Next document" disabled={next === null}
      onPress={() => { if (next !== null) onOpen(next); }} />
  </View>;
}

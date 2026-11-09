import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { errorText } from "../shared/errors";
import { REVIEW_MAX_NOTE_CHARS } from "../shared/limits";
import { docOpenRpc, viewerStateReadRpc } from "../shared/rpc";
import { baseName, humanSize } from "./format";
import { documentQueryOptions, viewerMarksQueryKey } from "./queries";
import { noteLocation, pageImageKey, reviewDrafts, reviewScope, reviewUnit, type ReviewNote, useReviewDraft } from "./review-draft";
import { formatReview, noteRevisionStatus, type PinLabel } from "./review-message";
import { canAttachPage, useAttachPage } from "./review-note";
import { recipientStatusLabel, type ReviewRecipient, reviewRecipients, selectedRecipientId, sendReview } from "./review-send";
import { makeStyles, MessageState, type Styles, ToolbarButton } from "./ui";
import { useBottomInset } from "./use-bottom-inset";

const AGENT_POLL_MS = 5_000;
const AGENT_LIST_LIMIT = 200;

type Outcome = { tone: "done"; text: string; agentId: string } | { tone: "danger"; text: string };

export function ReviewScreen({ host, theme, layout, params, navigation }: PluginScreenProps) {
  const { ref, onLayout, bottomInset } = useBottomInset();
  const styles = useMemo(() => makeStyles(theme, layout.compact, bottomInset), [theme, layout.compact, bottomInset]);
  const workspaceId = params.workspaceId ?? "";
  const scope = reviewScope(host?.id, workspaceId);
  const draft = useReviewDraft(scope);
  const toast = useToast();
  const paseo = usePaseo();
  const openDocument = useRpc(docOpenRpc);
  const readMarks = useRpc(viewerStateReadRpc);
  const attachPage = useAttachPage(workspaceId);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [preselectedId, setPreselectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const paths = useMemo(() => [...new Set(draft.notes.map((note) => note.path))], [draft.notes]);
  const opened = useQueries({
    queries: paths.map((path) => ({ ...documentQueryOptions(workspaceId, path), queryFn: () => openDocument({ workspaceId, path }), retry: false })),
  });
  const revisions = new Map(paths.map((path, index) => [path, opened[index]?.data?.revision]));
  const currentRevision = (path: string) => revisions.get(path);
  const marks = useQueries({
    queries: paths.map((path) => ({ queryKey: viewerMarksQueryKey(workspaceId, path), queryFn: () => readMarks({ workspaceId, path }), staleTime: 10_000, retry: false })),
  });
  const pins = new Map(paths.map((path, index) => [path, marks[index]?.data?.pins ?? []]));
  // A pin names the page only for the revision it was saved or confirmed on.
  const pinLabel: PinLabel = ({ path, page, revision }) => pins.get(path)?.find((pin) => pin.index === page && pin.revision === revision)?.label;
  const message = formatReview(draft, currentRevision, pinLabel);
  const imageBytes = message.images.reduce((total, image) => total + Math.floor((image.data.length * 3) / 4), 0);

  const agents = useQuery({
    queryKey: ["review.agents", workspaceId],
    queryFn: async () => (await paseo.agents.list({ page: { limit: AGENT_LIST_LIMIT } })).entries.map((entry) => entry.agent),
    enabled: workspaceId !== "",
    refetchInterval: AGENT_POLL_MS,
  });
  const recipients = useMemo(() => reviewRecipients(agents.data ?? [], workspaceId), [agents.data, workspaceId]);
  // Until the reviewer picks one, the most recently active idle agent is selected, and it stays
  // selected when it turns busy so the hint below says why Send is off.
  const chosenId = selectedRecipientId(recipients, recipientId, preselectedId);
  const recipient = recipients.find((each) => each.id === chosenId) ?? null;
  useEffect(() => {
    if (recipientId === null && chosenId !== preselectedId) setPreselectedId(chosenId);
  }, [recipientId, chosenId, preselectedId]);

  const copy = () => {
    copyText(message.text).then(
      () => toast.show(message.images.length > 0 ? "Review copied without the page images" : "Review copied"),
      () => toast.error("Could not copy the review"),
    );
  };

  const send = async () => {
    if (!recipient) return;
    const sent = draft.notes.map((note) => note.id);
    const name = agentName(recipient);
    setSending(true);
    setOutcome(null);
    try {
      const result = await sendReview(paseo.agents, recipient.id, message);
      if (result.status === "sent") {
        reviewDrafts.removeNotes(scope, sent);
        setRecipientId(null);
        setOutcome({ tone: "done", text: `Review sent to ${name}`, agentId: recipient.id });
      } else if (result.status === "busy") {
        setOutcome({ tone: "danger", text: `${name} is not ready (${result.label.toLowerCase()}). Nothing was sent; the draft is kept.` });
      } else {
        setOutcome({ tone: "danger", text: `${name} is no longer available. Nothing was sent; the draft is kept.` });
      }
    } catch (failure) {
      setOutcome({ tone: "danger", text: `Could not send the review: ${errorText(failure) || "unknown error"}. The draft is kept.` });
    } finally {
      setSending(false);
      void agents.refetch();
    }
  };

  const toggleImage = async (note: ReviewNote) => {
    const key = pageImageKey(note);
    if (key in draft.images) {
      reviewDrafts.detachImage(scope, key);
      return;
    }
    setAttaching(note.id);
    try {
      await attachPage(scope, note);
    } catch (failure) {
      toast.error(`Could not attach the page image: ${errorText(failure)}`);
    } finally {
      setAttaching(null);
    }
  };

  const saveEdit = () => {
    if (!editing) return;
    reviewDrafts.editNote(scope, editing.id, editing.text);
    setEditing(null);
  };

  if (draft.notes.length === 0) {
    return (
      <View ref={ref} onLayout={onLayout} style={styles.screen}>
        {outcome?.tone === "done" ? (
          <MessageState theme={theme} styles={styles} icon="Send" title={outcome.text} detail="The sent notes were removed from the draft."
            action={navigation ? { label: "Open agent", onPress: () => navigation.openAgent({ agentId: outcome.agentId }) } : undefined} />
        ) : (
          <MessageState theme={theme} styles={styles} icon="ClipboardList" title="No review notes"
            detail="Open a PDF or PowerPoint and use Add note on the page or slide you are viewing." />
        )}
      </View>
    );
  }

  const groups = paths.map((path) => ({ path, notes: draft.notes.filter((note) => note.path === path).sort((a, b) => a.page - b.page) }));
  const locked = sending || attaching !== null;

  return (
    <View ref={ref} onLayout={onLayout} style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.text}>{draft.notes.length === 1 ? "1 note" : `${draft.notes.length} notes`}</Text>
        <View style={styles.toolbarSpacer} />
        <ToolbarButton theme={theme} styles={styles} icon="Copy" label="Copy review" onPress={copy} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.gutter + styles.bottomInset, gap: 16 }}>
        <Text style={styles.muted}>
          Notes are kept in this app session only and are lost when the app reloads. Nothing is sent until you choose an agent and press Send review.
        </Text>
        {groups.map((group) => (
          <View key={group.path} style={{ gap: 8 }}>
            <Text style={[styles.text, { fontWeight: "600" }]} numberOfLines={1}>{group.path}</Text>
            {group.notes.map((note) => {
              const older = noteRevisionStatus(note, currentRevision(note.path)) === "older";
              const attached = pageImageKey(note) in draft.images;
              const isEditing = editing?.id === note.id;
              return (
                <View key={note.id} style={[styles.card, { padding: 12, gap: 8 }]}>
                  <View style={styles.toolbarGroup}>
                    <Text style={styles.label}>{noteLocation(note)}</Text>
                    {older ? <Text style={[styles.label, { color: theme.colors.statusWarning }]}>Older revision: the file changed since this note</Text> : null}
                    {attached ? <Text style={styles.label}>Page image attached</Text> : null}
                  </View>
                  {isEditing ? (
                    <TextInput value={editing.text} onChangeText={(text) => setEditing({ id: note.id, text })} multiline autoFocus maxLength={REVIEW_MAX_NOTE_CHARS}
                      accessibilityLabel="Edit note text" style={[styles.text, styles.card, { minHeight: 64, padding: 8, textAlignVertical: "top" }]} />
                  ) : (
                    <Text style={styles.content} selectable>{note.text}</Text>
                  )}
                  <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
                    {isEditing ? (
                      <>
                        <ToolbarButton theme={theme} styles={styles} icon="Check" label="Save" variant="primary" disabled={!editing.text.trim()} onPress={saveEdit} />
                        <ToolbarButton theme={theme} styles={styles} label="Cancel" onPress={() => setEditing(null)} />
                      </>
                    ) : (
                      <>
                        <ToolbarButton theme={theme} styles={styles} icon="Pencil" label="Edit" accessibilityLabel={`Edit note on ${noteLocation(note).toLowerCase()}`}
                          disabled={locked} onPress={() => setEditing({ id: note.id, text: note.text })} />
                        <ToolbarButton theme={theme} styles={styles} icon="Trash2" label="Remove" accessibilityLabel={`Remove note on ${noteLocation(note).toLowerCase()}`}
                          disabled={locked} onPress={() => reviewDrafts.removeNote(scope, note.id)} />
                        {reviewUnit(note) === "page" ? <ToolbarButton theme={theme} styles={styles} icon={attached ? "ImageOff" : "ImagePlus"} label={attached ? "Remove page image" : "Attach page image"}
                          accessibilityLabel={`${attached ? "Remove" : "Attach"} page ${note.page + 1} image`}
                          disabled={locked || (!attached && (older || !canAttachPage(draft, note)))} onPress={() => void toggleImage(note)} /> : null}
                        {attaching === note.id ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
                      </>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
        <View style={{ gap: 8 }}>
          <Text style={[styles.text, { fontWeight: "600" }]}>Message preview</Text>
          <View style={[styles.card, { padding: 12 }]}>
            <Text style={[styles.text, { fontFamily: "monospace", fontSize: 12 }]} selectable accessibilityLabel="Review message">{message.text}</Text>
          </View>
          {message.images.length > 0 ? (
            <Text style={styles.muted}>
              {message.images.length === 1 ? "1 page image" : `${message.images.length} page images`} ({humanSize(imageBytes)}) will be attached. Copy review copies the text only.
            </Text>
          ) : null}
        </View>
        <RecipientPicker theme={theme} styles={styles} recipients={recipients} loading={agents.isPending} error={agents.error}
          selected={chosenId} disabled={sending} onSelect={setRecipientId} />
        {outcome ? (
          <Text style={outcome.tone === "danger" ? styles.danger : styles.text} accessibilityRole={outcome.tone === "danger" ? "alert" : undefined}>{outcome.text}</Text>
        ) : null}
        <View style={styles.toolbarGroup}>
          <ToolbarButton theme={theme} styles={styles} icon="Send" label={recipient ? `Send review to ${agentName(recipient)}` : "Send review"} variant={editing ? "default" : "primary"}
            disabled={!recipient?.ready || locked || editing !== null} onPress={() => void send()} />
          {sending ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        </View>
        {recipient && !recipient.ready ? (
          <Text style={styles.muted}>{agentName(recipient)} is {recipientStatusLabel(recipient).toLowerCase()}. Wait until it is idle, or copy the review.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function agentName(agent: ReviewRecipient): string {
  return agent.title?.trim() || `Untitled ${agent.provider} agent`;
}

function RecipientPicker({ theme, styles, recipients, loading, error, selected, disabled, onSelect }: {
  theme: PluginTheme; styles: Styles; recipients: readonly ReviewRecipient[]; loading: boolean; error: unknown;
  selected: string | null; disabled: boolean; onSelect(id: string): void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.text, { fontWeight: "600" }]}>Send to</Text>
      {loading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
      {error ? <Text style={styles.danger}>Could not list agents: {errorText(error)}</Text> : null}
      {!loading && !error && recipients.length === 0 ? (
        <Text style={styles.muted}>No agents in this workspace. Start one, or copy the review.</Text>
      ) : null}
      {recipients.map((agent) => {
        const chosen = agent.id === selected;
        return (
          <Pressable key={agent.id} accessibilityRole="radio" accessibilityLabel={`${agentName(agent)}, ${recipientStatusLabel(agent)}`}
            accessibilityState={{ selected: chosen, disabled: disabled || !agent.ready }} aria-checked={chosen} disabled={disabled || !agent.ready} onPress={() => onSelect(agent.id)}
            style={[styles.card, { padding: 10, flexDirection: "row", alignItems: "center", gap: 8 }, chosen ? { borderColor: theme.colors.accent } : null,
              !agent.ready ? styles.disabled : null]}>
            <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>{agentName(agent)}</Text>
            <Text style={styles.label}>{agent.provider}</Text>
            <Text style={[styles.label, { color: agent.ready ? theme.colors.statusSuccess : theme.colors.statusWarning }]}>{recipientStatusLabel(agent)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

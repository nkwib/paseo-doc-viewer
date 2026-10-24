# Paseo host API proposals

Host changes the viewer needs. The first landed upstream as file panels; the
others are still proposals. The viewer continues to work with SDK 0.11.2.

## Open with Document Viewer (landed)

Landed in [getpaseo/paseo#7411](https://github.com/getpaseo/paseo/pull/7411) as
file panels, for Paseo 0.13.0. `client.addFilePanel` claims extensions or exact
filenames, and Paseo mounts the panel as the body of the file tab with a handle
to the file. The host owns Open with, the picker when panels compete, the
per-extension default and Settings > Files. Unlike this proposal, the panel
renders inside the file tab instead of opening a plugin screen.

## Open a workspace file in a file tab

File panels render the viewer inside Paseo's file tab, but a plugin cannot open
one. Paseo 0.13.0 gives plugins `openScreen` (a plugin screen), `openPanel` (the
plugin's own workspace or agent panel) and `navigation.openAgent`,
`openWorkspace` and `openBrowser`. None of them takes a file. So Documents shows
a document inside its own panel, and turn cards, `/doc` and Open recent document
open Documents or the standalone viewer, while the same file opened from the
Files tree gets a file tab.

Proposed: an optional `openFile({ workspaceId, path, serverId? })` on the client
context and on the workspace and agent command contexts, next to `openPanel`. It
behaves like a click in the Files tree. Paseo focuses the file's tab when one is
open, picks the panel through Open with and its per-extension default, follows
Open location, and uses the closable sheet on compact layouts. In the app,
`navigateToWorkspace` with a `{ kind: "file", path }` target already focuses an
open tab for the same path and follows the compact sheet rule. Open location is
applied by the pane's `openPreferredTarget`, not by `navigateToWorkspace`, so
the host call needs it too. `path` is relative to the workspace, like the Files
tree's, because tabs are keyed by path.

Once it lands, Documents opens a row with `openFile` and keeps its list, since
it no longer swaps in a reader. Turn cards, `/doc` and Open recent document use
it too. Hosts without it keep the in-panel reader, Back to documents and Open
full view.

New plugin navigation needs a workflow discussion first
([CONTRIBUTING.md](https://github.com/getpaseo/paseo/blob/main/CONTRIBUTING.md)).
[getpaseo/paseo#4460](https://github.com/getpaseo/paseo/pull/4460), which added
`navigation.openCommitDiff`, was closed for skipping it.

## Save/share a workspace original

A host action accepts workspace/path, display filename, expected revision and
abort signal; the host selects a native save dialog or mobile share sheet and
copies bytes through existing authenticated transport with progress. It returns
completed/cancelled rather than interpreting a cancelled picker as an error.

Do not pass whole files as base64 across the UI bridge. Check revision before and
during transfer; never export a mixture of revisions. A save destination must
not be supplied as an arbitrary daemon path. Preserve original encryption and
format. Test picker cancellation, low disk space, relay interruption, confinement,
filename handling and files larger than in-memory Blob limits.

File panels leave this open: `writeBytes` writes the workspace file and has no
device export.

## Seekable media source and native player

A proposed `openWorkspaceMedia` capability resolves an authenticated source from
workspace/path/revision with MIME, byte length, expiry and an explicit release
method. Its representation must be usable by browser and native players without
exposing daemon credentials. Agree the transport before choosing a URL scheme:
ordinary custom RPC callbacks cannot be used as HTML media sources.

The source must work over direct and relay/encrypted connections, allow bounded
random reads, and support seeking without full-file assembly. If HTTP is used,
implement Range/If-Range, 200/206/416, correct MIME/length, ETag tied to revision,
origin/authentication handling, expiry and revocation. Preserve Blob fallback on
older hosts. Test fast-start and tail-index MP4, unsupported codecs, replaced
files, expiring credentials, reconnect and bounded memory.

File panels leave this open too: `file.url()` is a `blob:` (web) or `file:`
(native) URL of the whole current file, so playback waits for the full read.

Expose a host-supplied media component with kind, source, playback state,
play/pause, current time, seek, duration, errors, mute/volume where available, and
lifecycle stop/release. The host bundles native modules; plugin npm dependencies
cannot add them. Define screen-unmount, interruption and app-background behavior.
Do not enable background playback by accident. Test audio and video on iOS and
Android, including physical devices and silent-mode behavior.

The current SDK `playAudio` helper does not expose pause/seek/per-playback stop;
it is insufficient for a full document-media player.

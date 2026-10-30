# Changelog

## 0.7.0 (2026-10-30)

### New

- On Paseo 0.13.0 and later, files opened from Paseo's Files tree, chat links and file search open in the viewer, inside Paseo's file tab (a file panel named Viewer). PDF, Office, Parquet, video, audio, TIFF and HEIC files open there without a prompt. CSV, TSV and JSON Lines also have Paseo's Source editor, so Paseo asks which to use each time until Don't ask me again is ticked, and a link to a line opens Source. PNG, JPEG, GIF and WebP stay with Paseo's Image panel. New `doc.locate` RPC turns the tab's absolute path into a workspace path on the daemon, and only for a file whose real path is inside the workspace; any other file shows Outside the workspace.

### Changed

- Requires Paseo 0.13.0 or later, on both the app and daemon. File panels use the published SDK contract.
- File panels watch for changes on disk and refresh the reader without transferring the whole file. Deletion clears cached content, and restoring a file recovers the reader.

### Fixed

- The reader's Open in tab button in Documents is now Open full view, and the first-open chooser and the Open documents setting hint say Full view opens the standalone viewer, not a tab.

## 0.6.0 (2026-10-21)

Reading PDFs inside Documents and the PDF page field come from [#1](https://github.com/nkwib/paseo-doc-viewer/pull/1) by [@CatIIIIIIII](https://github.com/CatIIIIIIII). Thank you.

### New

- Turn cards show a thumbnail of each PDF (page 1) and image as the turn left it, in place of the file icon. Other files, files over 64 MiB and files rewritten since keep the icon. `doc.thumbnail` now answers for images too, bounded on both edges: a PNG or JPEG that already fits is sent as it is, others as JPEG, or PNG where there is transparency.
- A document opened from a turn card has Previous and Next buttons that step through the card's files. The screen takes an optional `siblings` param (a JSON list of paths).
- Turn cards fold the new files of a new Git checkout (clone, worktree or submodule) into one row with a Show button, and do the same for any other new folder with more than 12 new files. Changed files stay listed file by file, and so do the files of a folder that existed when the turn started, even one `git init` made a repository or one deleted and made again. Files take the 12 rows before folder rows. The Show and Hide button keeps one name for screen readers ("Show or hide" and the folder) and tells them whether the row is open. No Git process runs: the workspace scan notes folders that hold a `.git` entry. A card with a folder row is timeline data version 2 (`groups` beside `files`); other cards are still version 1, which earlier versions of the plugin render too.
- Turn card rows say Opened once the file was opened in the viewer at the card's version or a later one, instead of keeping New or Changed forever. New `viewer-state.opened-revisions` RPC reads the opened mark of up to 50 files at once.
- File icons in Documents and on turn cards take a color per file type, from a palette checked for color blindness, with a gray fallback on themes where a color would fall under 3:1. New "Color file types" setting (on by default) turns them off for every client of the daemon. An open Documents panel picks up a change made on another client within about 35 s, while it polls (not while the window is hidden).
- Documents has a List, Details and Previews switch beside the search box. The daemon keeps the choice per layout class (phone-sized or wide) in `documents-view.json`, through new `documents-view.read` and `documents-view.write` RPCs. List stays the default. Quick presses are saved in order and the last one wins. Writes take `documents-view.lock` and keep what a later version saved, so daemons sharing the folder keep each other's choice; a damaged file is set aside as `documents-view.json.bad`.
- Details view: one line per file with Name, Folder (from 640 pt), Size, Modified (absolute) and Status columns. Phones keep 44 pt rows and drop the size column. The column titles are the list's sticky header, so they stay over their columns beside a scrollbar, and screen readers skip them: each row already names every column. A modified time on a later day shows its date.
- Previews view: PDF, PowerPoint and image groups as tile grids (page 1 or the picture, PDF page count in the caption), other groups as rows. Thumbnails are 160 or 240 px, load as tiles come into view and keep the last picture while a rewritten file settles. Each file version is asked for once while the search or the list changes, and a busy daemon is asked again only for tiles still in view. Below 240 pt it shows rows.
- Tree view: Documents as folders, folders first and both by name, numbers by value (`run-2` before `run-10`), with each folder's count of listed documents, single-folder chains on one row (`out/reports`) and the top level open. Expand all and Collapse all; a search or filter opens every folder on the way to a match. Open folders are kept per workspace, for the last 50 workspaces, and an open chain stays open when a new file splits it. A document opened from Tree steps through the files of its folder. Folder rows tell screen readers their parent folder, level and open state; on the web the list is a tree, and Space presses a row like Enter. Phones keep 44 pt rows, and the four-way switch stays beside the search box at 390 pt as icons; below 360 pt (the explorer sidebar) it takes its own row. The switch labels now need 600 pt instead of 520, so four fit.
- Documents filter chips carry their type's icon in its file type color (gray with "Color file types" off), a Files icon on All, and the status pill's icon on New and Needs review. Screen readers skip the icons.
- `doc.thumbnail` answers for PowerPoint: the picture saved with the deck unless it is one color (python-pptx, which agents often use, saves a white one in every deck), else slide 1's first picture, else slide 1's title (`preview.type` is `image` or `title`), with the slide count. It is a preview, not a rendered slide, and needs no Office or LibreOffice. Previews tiles and turn cards use it. The deck is read in the thumbnail's lane and kept only as the answer, so a grid of decks never holds up or evicts the document being read.
- Documents reads every file type in place, with Back to documents, the folder beside the file name, and Open in tab. Back keeps the list's search, filters, view, collapsed headings and scroll, and Previous and Next follow the list across types. A renamed or deleted file shows File not found.
- New "Open documents" setting (Auto, Side by side, Full view) for documents opened from turn cards, `/doc` and Open recent document. Phones always use the viewer screen; on desktop and web a Documents panel already on screen updates in place, else Side by side opens it in the explorer, Full view in its own tab, and Auto picks the explorer from a 1,100 pt window. The first document opened on a wide layout asks once, with drawn previews of both choices. The setting is optional, so settings saved before it still read.

### Changed

- Readers below 480 pt (the explorer, a narrow split) put Pages, Add note, Mark reviewed and Download original behind More, so Previous and Next, Find and the status keep one row; in the narrowest explorer, Previous and Next take a row of their own. A phone with no Previous and Next keeps every tool on the row. Desktop explorers keep desktop-sized controls.
- PDFs page with Previous and Next page buttons and a page number field on every layout, in place of the page chips and the phone's `< n / N >`, which opened the page map (Pages still does). The field keeps a number while it is being typed, and screen readers hear it as "Page number of N".
- `docs.recent` entries carry the file's `revision`, so clients can key thumbnails without opening each file.
- `docs.recent` takes a `limit` of up to 1,000 (was 50; the default stays 50) and leaves out the oldest entries past 8 MiB. Tree asks for 1,000. A truncated answer lists every reason in `truncatedBy`: `limit` (more matches than the limit), `bytes` (more than fit in 8 MiB), `entries` (the scan stopped at 50,000 entries), `folder` (a folder of more than 5,000 entries read in part) or `depth` (folders more than 16 levels deep skipped). Documents says each one, also when it lists nothing. `documents-view.json` accepts `tree`; files saved before it still read.
- `docs.recent` takes `since`, the `version` of the list the client holds, and answers `{ unchanged: true, version }` while the list is the same, so a Documents refresh that finds no change is a few bytes instead of the whole list, and Tree redraws only the rows that changed.
- Documents rows read as the file name first for screen readers, then type, folder, time and status. Before, they started with "Open" and the full path.
- On the web, screen readers hear whether a toggle, chip or checkbox is on, whether a Documents heading is expanded and which page map thumbnail is the current page. React Native Web drops `accessibilityState`, so these now also set the matching ARIA attribute. Mark reviewed keeps one name whether or not the file is reviewed, so that state is heard once.
- Turn cards scan the workspace afresh when a turn starts, instead of reusing a scan up to a few seconds old, so a folder made before the turn is not taken for one the turn made. A folder made in the second before the start still counts as new, as the start can be reported late, so an early `git worktree add` folds into one row. A scan begun in the second before is reused, so turns starting together share one, and no scan runs while Turn cards is off.
- Thumbnails a turn card asks for (`keepOpen: false`) open a PDF for that one call, so they never push the document open in the viewer out of the daemon's open set. They wait behind page map thumbnails, and a client asks for one at a time across all its cards, the card mounted last first. When the daemon is busy, the card asks again a little later, at a random point; that includes a thumbnail whose time ran out while it waited behind other PDF work. A thumbnail that ran out of time otherwise is not asked for again. If PDFium was still drawing it, the daemon does not try that file again for 10 minutes or until it changes, because each try restarts PDFium.
- `doc.thumbnail` takes an optional `revision`: a file changed since fails at once with "The file changed since it was listed", without being rendered. The daemon keeps thumbnails in a cache of their own, apart from pages, and bounds a PDF thumbnail's height to twice its width.
- The page map asks a busy daemon for a thumbnail again by itself, soon and up to 3 times. The thumbnail shows as loading meanwhile, and Retry appears only after the last try. Pressing Retry shows it as loading at once. A page scrolled away from meanwhile is asked for only once it is back on screen.

### Fixed

- A backslash in a file name (allowed on macOS and Linux) no longer splits it into a folder and a name in titles and Documents.
- Times in Documents ("5 min ago") are read again when the window gets focus or the app comes to the front, instead of waiting for the next minute tick, which a hidden window or a background app does not run.

## 0.5.2 (2026-10-19)

- Add reproducible HD listing images and a clearer description.
- Explain registry and GitHub install names and provide an explicit Git URL.
- Point phone users to the new tab menu and correct the Settings tip.

## 0.5.1 (2026-10-18)

### New

- Turn cards have a Settings link (a gear on phones) that opens Settings, Document viewer, where the cards can be turned off.
- First-run tips: a small card at the top of Documents shows four short tips, one at a time, with Next, Skip and Done. The daemon keeps the dismissal, so it holds for every client; the Tips link under the list shows them again.

### Changed

- Opening a file in the viewer clears its New pill in Documents until the file changes again. Like visits, this is shared by every client of the daemon.

### Fixed

- Review notes: when the preselected agent turns busy, it stays selected and the screen says why Send is off. Before, the selection moved to another idle agent, or to none with no explanation.
- Word tables fill their card when the columns fit. Before, every column was 160 px wide, which left an empty band after the last column on wide screens. Tables with more columns still scroll sideways.

## 0.5.0 (2026-10-18)

### New

- Turn cards: when an agent turn ends, the agent's timeline gets one card listing the supported documents changed while the turn ran, marked New or Changed, each with Open into the viewer. Up to 12 rows, then "+N more in Documents". Files written by shell scripts count; a turn that changed nothing gets no card. The list comes from file times, so it includes changes by anyone during the turn, not only that agent. Cards live in the daemon's memory and are gone after a daemon restart. Turn them off in Settings, Document viewer.
- New filter: Documents shows a New pill and filter, next to Needs review, for files that appeared or changed since your last visit to Documents in that workspace and were never reviewed. The first visit marks nothing as new. New `docs.visit` RPC; `docs.recent` takes `newSince` and `newOnly`.
- JSON Lines (.jsonl, .ndjson) open in the sheet grid and Records, under Spreadsheets and data. Nested keys become `a.b.c` columns, an invalid line shows its error in its row and is listed in Issues, and integers beyond 2^53 keep every digit. A 50,000-line file opens in about 0.1 s.
- Parquet (.parquet) opens in the same grid, reading only the footer and the row groups and columns on screen, with each column's declared type in the inspector. Snappy, gzip, Brotli, Zstandard and LZ4 are supported, LZO is not. A row group that would need more than 64 MiB in memory is refused with a message asking for smaller row groups.
- Full cell values: Show full value in the cell inspector reads a whole cell (up to 256 KB) with Copy, for spreadsheets, CSV, JSON Lines and Parquet. The grid still cuts cells at 2,000 characters. New `doc.cell` RPC.

### Fixed

- Excel formulas saved with an empty result (as openpyxl writes them) show their formula text instead of looking blank, and Issues lists them.
- Find in a spreadsheet no longer skips matches after opening a result. Find and Issues jumps keep column A in view, and Records remembers the header row per sheet.
- Workbooks with dimension or cell references past Excel's limits open.
- Zoom is remembered separately for phone-sized and wide layouts, so a desktop zoom no longer opens cropped on a phone.
- Bare `/doc` and "Open recent document" open the newest PDF, Word, spreadsheet, data or slide file before images and media, so a fresh screenshot no longer wins over a report.
- The document title shows the folder (`report.pdf · runs/eval`), so files with the same name can be told apart.
- Documents search names up to 3 matching files of unsupported types instead of saying "No files match".
- The Documents header button appears right after an agent's turn ends instead of up to 2 minutes later. Documents uses the FileText icon.
- Review message: each file states the modified time and exact size of the version you reviewed, notes on pinned pages carry the pin label, and the most recently active idle agent is preselected.
- A half-typed review note survives leaving the document or switching workspace.

### Robustness

- A malformed TIFF, a Word file hiding its main part, a PNG with an enormous header, or a forged Parquet footer is refused instead of crashing the viewer.
- PDFs render in a worker thread: a PDF that crashes PDFium fails alone, and a slow page no longer blocks other documents.
- Find in wide CSVs, and Excel, PowerPoint and Word files with unclosed tags, no longer freeze the viewer. PDF work past its 20 s deadline is stopped.
- File names and pin labels are quoted in the review message, so a file name cannot forge lines or notes sent to the agent.
- Saved positions, pins and review marks merge across daemons sharing the folder, are trimmed instead of wiped when oversized, and stay separate for a daemon with its own `PASEO_HOME`.

## 0.4.0 (2026-10-17)

- PDF page map: a Pages button shows a grid of low-resolution page thumbnails (2 or 3 columns on phones). Thumbnails load visible pages first, at most two at a time per map, on one background render slot that never takes the last slot from page renders. Closing the map stops further requests; a tap opens the page. New `doc.thumbnail` RPC (PDF only, 48 to 320 px wide, under 256 KB).
- Page pins: pin the current page from the page map with an optional label (up to 60 characters, 30 pins per document). Each pin keeps the file revision it was saved with; after a rewrite it shows "May need checking" until confirmed, or says the page no longer exists. New `viewer-state.pin` RPC; `viewer-state.read` also returns `pins` and `review`.
- Review marks: Mark reviewed records the revision on screen. A status pill ("Reviewed" or "Changed since review") shows in the document toolbar and in Documents, with a Needs review filter listed first. Opening, scrolling or a saved position never marks a file reviewed, and a file that changed before the press is not marked. New `viewer-state.review` RPC; `docs.recent` takes `needsReview` and returns a per-entry `review` and a `needsReview` count.
- Review notes: Add note in the PDF toolbar adds a note to the page you are viewing, optionally with that page's image. Notes from any file in the workspace collect in a Review notes screen, where you can edit or remove them and preview the exact message, then copy it or send it to an agent you choose in the workspace. Notes on a file that has changed since are marked as an older revision. Sending only goes to an agent with no turn in progress and no pending permission; a busy agent is never interrupted, and a refused or failed send keeps the draft. Drafts live in app memory only (up to 50 notes of 2,000 characters). New `review.page-image` RPC renders an attached page at the note's revision, at most 2000 px per side and 5 images per review.
- Spreadsheet cell inspector: tap a cell to see its sheet-qualified address, formula, saved result, raw value, type and number format. A formula without a saved result is shown as information. Shared formulas that cannot be adjusted exactly name their master cell instead of showing a reconstructed formula. `doc.rows` takes `detail` and returns per-cell `details`.
- Record view: read one spreadsheet row at a time as a vertical card, labelled by a header row you choose. The grid stays the default.
- Issue check for Excel workbooks: lists error cells and formulas without a saved result, states which rows were inspected and where a bounded check paused (3 s, 250,000 rows or 200 issues per call), and jumps to the cell. New `doc.issues` RPC.
- The PDF toolbar fits a 390 px phone: on compact layouts Find, Pages, Add note, Review notes and Mark reviewed are icon-only, and Add note sits with the review controls instead of the page controls. Phones use 44 pt touch targets and a `< n / N >` page control that opens the page map; desktop keeps page chips between previous and next.
- Controls: toggles show a neutral fill when on, actions are outlined, and the accent marks only the main action on a screen. Download original moved into the document toolbar. Find results show the page, a two-line snippet with the match in bold, and "n of N".
- Errors are toned by kind and offer no download when the file is missing or outside the workspace. Images at Fit are no longer enlarged past their size (reverses 0.3.0) and show their pixel size. Audio and video controls follow the light or dark theme.
- Loading feedback: video/audio and animated images show a spinner, byte progress and Cancel loading while transferring. Original downloads also show a spinner. File processing yields between chunks and base64 blocks so navigation stays responsive; cancelled animations keep their first frame and can be loaded again.
- Mobile audio: leaving or cancelling during loading prevents playback from starting later. The 32 MiB limit and opened file revision are checked against the transferred file before preparing playback.
- Find in PDF: matches are highlighted in place on the rendered page and the page scrolls to the selected match, instead of always switching to the extracted text. `doc.search` returns normalized `boxes` for PDF matches, computed from PDFium's character boxes; a match without page geometry still opens the page text.
- Audio plays in the mobile apps: a Play button streams the file and hands it to the host's `playAudio` (Paseo 0.11.2 and later), capped at 32 MiB. Playback runs to the end of the file with no pause or seek; on hosts without `playAudio` the viewer shows the availability message as before.
- Audio: MP3, M4A, WAV and FLAC play in the desktop and web apps with play, pause, seek and volume, listed under a new Audio heading.
- Reading positions: PDF and slide page, zoom and text mode, image zoom, and spreadsheet sheet index and row/column window are restored when a file is reopened, shared by every client of the daemon. They are stored on the daemon host under `$PASEO_DOC_VIEWER_STATE_DIR`, `$XDG_STATE_HOME/paseo-doc-viewer` or `~/.local/state/paseo-doc-viewer`, keyed by an HMAC of the path with a per-install secret (0600). New `viewer-state.read` and `viewer-state.write` RPCs.
- Find in document for PDF, Word, Excel, CSV and PowerPoint text (`doc.search`). Each call scans for up to 3.5 s or 50 matches and returns a cursor; the panel keeps going on its own up to 500 results. CSV and xlsx sheets are streamed once per search, xlsx shared strings are matched once per query, the scan yields to other requests every 40 ms, and a newer search from the same panel stops the older one. The selected match is highlighted and scrolled into view.
- Download original (`file.info`, `file.chunk`): saves the original bytes, also when previewing fails, up to 128 MiB. Only supported file types outside hidden files and folders, and the opened file must still be the one the workspace path resolves to.
- The Documents header button appears only in workspaces with documents. It checks with the new `docs.any` RPC every 2 minutes, two workspaces at a time, backing off to 10 minutes after errors.
- Workspace lookups ask the daemon for the one workspace by id instead of paging through all of them.
- Android: the bottom inset uses the SDK's `useSafeAreaInsets` when a host exports it, and is re-measured when the window size changes.

## 0.3.0 (2026-10-16)

- Documents panel: files are grouped under collapsible PDF, Word, Excel, PowerPoint, Images and Video headings with counts, newest first within each group.
- Documents panel: type filter buttons and a search box (name or folder, case-insensitive, every word must match). `docs.recent` takes optional `query` and `group` and filters the whole scan before the 50-entry cap, so older files are found. It also returns per-type `counts`.
- A Documents button in the workspace header opens the panel (icon only on phones). The panel uses the FileStack icon so it no longer looks like the built-in Files tab.
- CSV and TSV open in the sheet grid, paged with the Excel row, column and cell caps, 64 MB file cap. They are listed under Spreadsheets (was Excel) and found by search, the type filter, the Command Center and `/doc`.
- Android: lists, grids and pages end above the system navigation bar. The SDK has no safe-area insets for plugins, so the viewer pads the part of its frame that overlaps the navigation bar, using the bottom inset the app reported at launch (48 dp if unknown).
- Zoomed pages, slides and images: the viewer takes one-finger drags from touch start and pans itself, with a short fling on release. On Android a fast swipe to the left no longer opens the sidebar; a fast swipe to the right still can.
- PowerPoint: slide text scales with zoom, and text-only slides can be zoomed.
- Images smaller than the view, such as a small animated WebP, are enlarged to fit it instead of showing at pixel size.
- PDF text view: the copy button takes the zoom controls' slot, so the page counter and next button no longer move.
- Animated GIF and WebP play on desktop, web, iOS and Android. `doc.open` reports `animation` for files with more than one frame up to 16 MB, and `media.chunk` serves their original bytes. Larger files keep the first frame. The mobile apps cannot play animated WebP, so they request `media.chunk` with `mimeType: "image/gif"` and the daemon converts the WebP to GIF with imagescript (up to 500 frames, 32 million decoded pixels and a 16 MB GIF; above that the first frame stays).
- PDF: a password-protected PDF shows a password field and opens with the right password; a wrong one shows an error. `doc.open`, `doc.page` and `doc.text` take an optional `password`, and the error codes `password_required` and `password_incorrect` replace `password_protected`. The app keeps the password in memory for the open document and sends it with each request. The daemon uses it only to open the file: it is not logged or stored, and caches are keyed by a salted hash, so the 60 s PDFium recycle reopens the file with the resent password.
- An open document is still re-read every 5 s to pick up changes, but one that failed to open (including a locked PDF waiting for its password) is not, so the password field keeps what was typed. Retry reopens it.
- On iOS and Android the password field stays above the keyboard with the error line visible, and the keyboard stays open after a wrong password.

## 0.2.0 (2026-10-16)

- Excel: numbers follow the cell's number format (percent, currency, fixed decimals, thousands separators, custom codes) using SheetJS ssf. General numbers no longer show float noise (0.1 + 0.2 shows 0.3). Times, durations and date-times follow their format (18:00, 36:00, 2026-01-14 18:00); pure dates still show as YYYY-MM-DD.
- PDF: a text button shows the current page's text as selectable text, with a copy button. New `doc.text` RPC, capped at 100,000 characters per page.
- PDF: PDFium and its open documents are released after 60 s without PDF work and reloaded on the next request, so the daemon gives back the memory of a large render.

## 0.1.1 (2026-10-16)

- Renamed to "PDF and Office viewer" (plugin id unchanged). New first listing image showing desktop, iOS and Android.
- Each render job now times out after 20 s and frees its slot, so a hung read can no longer block every later document.
- Rendered pages are capped at 3072 px on the long edge (was 4096).
- The recent list shares one workspace scan between concurrent requests and reuses it for at least 4 s.
- The recent list now includes `build`, `dist` and `out`, scanned after other folders.
- CI: typecheck and tests on push and pull requests, plus a weekly install check against Paseo main.

## 0.1.0 (2026-10-16)

- First release: PDF, Word, Excel, PowerPoint, image and video files from the workspace, rendered on the daemon host, on desktop, web and mobile.
- Documents panel, Command Center actions and the `/doc` slash command.

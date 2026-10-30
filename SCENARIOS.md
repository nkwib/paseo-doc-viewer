# Scenarios

Each row is a failing test first, then a fix. Source is the report in
[getpaseo/paseo discussion #3109](https://github.com/getpaseo/paseo/discussions/3109).

| ID | Reported by | Scenario | Where it is fixed |
| --- | --- | --- | --- |
| S1 | dthinkr, LimDaeKyung | The plugin installs on Paseo 0.11 (layout, `requirements.paseo`, import boundaries). Builds on DBHQ paseo-file-viewer, which predates the 0.11 contract (credited in NOTICE). | plugin |
| S2 | YASICJUNWOO, dthinkr | A PDF renders on a daemon host with no poppler, ImageMagick, or LibreOffice installed. | plugin |
| S3 | dthinkr | An agent rebuilds `main.pdf`; the viewer shows the new content, not a cached render. The most recently changed document is one tap away. | plugin |
| S4 | original post, MACscr | Remote daemon over relay: every RPC response fits the relay frame budget and returns well inside the 60 s RPC timeout, including huge pages and images. | plugin |
| S5 | grinidx | A `.docx` renders as readable blocks (headings, paragraphs, tables, images). | plugin |
| S6 | original post, grinidx | A `.xlsx` renders paged, with rows and columns capped so a wide sheet stays within budget. | plugin |
| S7 | original post | A `.pptx` deck shows a slide strip with each slide's text and images, without Office installed. | plugin |
| S8 | MACscr, rangerrick337 | An `.mp4` the agent recorded plays in the app. | plugin (web/desktop), shortcoming on native |
| S9 | LimDaeKyung | HEIC and TIFF images render. | plugin |
| S10 | grinidx, dthinkr, LimDaeKyung | Clicking a document in the built-in Files tree opens it in the viewer. | plugin file panels on Paseo 0.13.0 and later; verified with the real host in `npm run test:host` |
| S11 | paseo #5783 | The compiled client bundle loads on iOS (Hermes): no syntax Hermes rejects. | plugin |

## File tab integration (S10)

File panels render the viewer inside Paseo's file tabs when a supported file is opened from Files, a chat file link or file search. Paseo owns tab selection, splitting and Open with associations. The plugin keeps its bounded page and row RPCs and watches the file handle for changes.

Documents, turn cards and `/doc` still open the in-panel reader or the standalone screen. Routing those entry points into a file tab needs a public `openFile` navigation API; see [the host proposal](docs/host-api-proposals.md#open-a-workspace-file-in-a-file-tab).

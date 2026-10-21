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
| S10 | grinidx, dthinkr, LimDaeKyung | Clicking a document in the built-in Files tree opens it in the viewer. | host API landed as file panels (getpaseo/paseo#7411, Paseo 0.13.0); the viewer does not use them yet |
| S11 | paseo #5783 | The compiled client bundle loads on iOS (Hermes): no syntax Hermes rejects. | plugin |

## Core gaps (S10)

Verified on `getpaseo/paseo` main `2d86b94b2` (0.11.2):

- `PluginClientContext` has no file-preview contribution point (`packages/plugin/src/client/contracts.ts:133-154`). The file pane render branch is hardcoded (`packages/app/src/file-pane/pane.tsx:173-231`).
- `PluginWorkspaceSnapshot` carries no selected file (`packages/plugin/src/contracts.ts:20-34`).
- `openPanel` forwards only `{ location }` (`packages/app/src/plugins/client-runtime.ts:66`), so a panel cannot be opened on a file.
- The daemon labels `.pdf` as `application/octet-stream` (`packages/server/src/server/file-explorer/service.ts:117-124`).

Plugin-side mitigation: a screen opened with `params.path`, a Command Center item, and a recent-documents list ordered by mtime.

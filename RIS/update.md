# FULLPACSRIS Update Notes - 2026-05-18 Morning

## Scope

This repository is the distribution snapshot. The morning update syncs the active application source from:

- `C:\NEXIOMINIO\buildpacs\minipacsris`

into:

- `C:\NEXIOMINIO\buildpacs\FULLPACSRIS\minipacsris`

No dicomweb-pacs or nexia-viewer-source source changes were required for this morning UI/workflow update.

## Product Updates Included

- Technologist, Reporting, and Distribution summary cards now support click-to-filter.
- Date filters remain usable while card filters are active.
- Worklist, Technologist, Reporting, and Distribution tables now have thin modern vertical and horizontal scrollbars.
- Mobile table toolbar alignment was improved so search and filter controls stay neat in one row.
- Reporting report editor action footer remains transparent/glass, while action buttons are solid and palette-aligned.
- Duplicate template names no longer cause multiple template rows to appear selected/highlighted.
- Added dedicated `view_management_report` permission for `/report` and `/api/management-reports`.
- Added Mobility viewer configuration through `minipacsris/backend/settings.json`:
  - `name`: `Mobility`
  - `baseUrl`: `http://localhost:5991`
  - `path`: `/mobile`
  - `queryParam`: `studyUID`
- Phone mode in `reporting/report/:studyInstanceUid` shows the Mobility button when the viewer config is available.

## Notes For Next AI Agent

- Treat `FULLPACSRIS` as a release/distribution repo, not the daily development repo.
- Active development remains in `C:\NEXIOMINIO\buildpacs\minipacsris`.
- When releasing, sync into `FULLPACSRIS\minipacsris` while excluding:
  - `.env`
  - `node_modules`
  - `dist`
  - logs
  - DICOM/runtime data
  - MWL outbox/debug outbox
  - Python `.venv`, `__pycache__`, and `*.pyc`
- Do not hardcode Mobility URLs in React; keep viewer launch behavior driven by `backend/settings.json`.
- After deployment, restart backend so `/api/ui/viewers` reloads `settings.json`.
- Users may need to log out/in for updated role permissions to refresh in the frontend session.

## Verification

- Frontend build passed with `npm run build` in `minipacsris`.
- Backend syntax check passed with `node --check backend/index.js` in `minipacsris`.

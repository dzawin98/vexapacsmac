# Update Notes - 2026-05-18 Morning

Repository update target: `https://gitea.sitermid.my.id/dzawin/FULLPACSRIS.git`

## Summary

This update contains the active NEXIA PACS/RIS product work from the morning session. The focus was mobile responsiveness, workflow card filtering, reporting UX polish, role permission updates, and viewer configuration.

## UI And Workflow Updates

- Reporting, Technologist, and Distribution summary cards now support click-to-filter behavior.
- Date filtering remains available while a summary card filter is active, so the list can be filtered by both card state and date.
- Worklist, Technologist, Reporting, and Distribution tables now have thin modern horizontal and vertical scrollbars.
- Shared worklist toolbar layout was improved for phone mode so search and filter controls remain aligned in one row.
- Reporting report editor action buttons were restyled:
  - footer remains transparent/glass
  - action buttons are solid, distinct, and aligned with the system palette
  - Close uses neutral slate, not red
- Template picker duplicate-title bug was fixed by using unique command values based on template ID plus title.

## Permissions

- Added dedicated permission `view_management_report` for `/report`.
- `/report` route, Management sidebar Report item, Users role-permission UI, and `/api/management-reports` now use `view_management_report` instead of `view_dashboard`.
- Default admin permissions include `view_management_report`.

## Viewer Configuration

- Added `Mobility` viewer through `backend/settings.json` only, not hardcoded in React.
- Mobility config:
  - `baseUrl`: `http://localhost:5991`
  - `path`: `/mobile`
  - `queryParam`: `studyUID`
- Mobile phone mode in `reporting/report/:studyInstanceUid` now shows a `Mobility` button when the Mobility viewer config is available from `/api/ui/viewers`.
- Mobility opens as `http://localhost:5991/mobile?studyUID=<StudyInstanceUID>`.

## Important For Next AI Agent

- Restart backend after pulling this update so `backend/settings.json` is re-read.
- Log out and log in again if role permissions do not appear immediately in the frontend session.
- Do not reintroduce hardcoded Mobility URLs in React; use `backend/settings.json` viewer config.
- Keep the reporting action footer transparent, but action buttons should stay solid.
- Keep table scrollbars thin and visible; do not restore the old hidden-scrollbar rule.
- For duplicate template names, keep command item values unique by ID to avoid multiple highlighted rows.
- The worktree intentionally includes a broad product update. Runtime folders such as MWL outbox/debug outbox are not required for source behavior and should remain untracked unless specifically needed.

## Verification Performed

- `npm run build` passed after the UI and viewer changes.
- `node --check backend/index.js` passed after backend permission/config changes.

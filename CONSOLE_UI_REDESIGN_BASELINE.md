# Console UI Redesign Baseline

This file records the pre-redesign frontend inventory and regression contract for
`codex/console-ui-redesign`.

## Git baseline

- Base branch: `main`
- Starting commit: `4e4625a feat: add secure login status snapshot`
- Redesign branch: `codex/console-ui-redesign`
- Existing unrelated files preserved outside commits: 28 untracked `test/* 2.js`
  duplicate files
- Backend, database, authentication, authorization, API, Docker, deployment and
  runtime configuration are outside this redesign

## Application shell

The authenticated console is one inline JavaScript SPA in `public/index.html`.
Navigation switches 14 `section` elements without changing the URL.

- Shell: fixed/sticky sidebar, sticky topbar, centered main content, three global
  modal overlays and one global toast
- Sidebar: 14 routes in the existing order, three navigation groups, four live
  device footer states, mobile backdrop/drawer behavior
- Topbar: mobile navigation trigger, page title/subtitle, critical alert banner,
  Site Manager state, layout editor, theme toggle and logout
- Shared UI runtime: design tokens, table scroll regions, keyboard activation for
  clickable cards, loading/empty/error state observer, chart tooltip/detail/legend,
  modal focus return, Escape close and reduced-motion handling
- Existing theme modes: dark and light

## Page inventory

| Page | Main content and preserved interactions |
|---|---|
| Overview | Four KPI cards; UCG/NAS/WiiM vital cards; security summary; hourly and multi-series trend charts; 1h/6h/24h/3d/7d/30d range controls; switch/port matrix; pinned layout blocks |
| UCG | Live temperature/core/resource panels; hardware and history charts; 10m/30m/2h/6h/24h/7d ranges; CSV download; spike events; AdGuard per-device service policy form |
| Clients | Search; client count/refresh metadata; four-column client table; keyboard-openable rows; rename; block/unblock; traffic ranking; access-control history; client detail modal |
| Security | Defense status and toggle; security score and analytics; hourly/pie charts; reset; 1d/3d/7d/30d time filter; search; severity/category filters; eight-column threat table; CSV export; copy IP; expiring IP block/remove controls |
| WiFi | SSID state controls; guest SSID/password inputs; same-origin QR generation |
| Cloud | Site Manager status and ISP metrics; Sites/Devices/Hosts/SD-WAN tabs |
| NAS | Overview and hero status; resource cards; disks/volumes; five charts; 10m/30m/1h/6h/24h/7d ranges; Docker table/actions/log modal; SMART modal; sleep statistics; alert threshold form/delete; log filters; alert acknowledgement; SSE status |
| AdGuard | Protection state/toggle; manual refresh; four KPI cards; top domains/clients; query and blocked logs; per-device policy rendering |
| Linux host | Host overview; six KPI cards; CPU/temperature/memory chart; 1h/6h/24h/7d ranges |
| Tools | Speed test start/result/retest; PoE MAC/port form and power-cycle action |
| Notifications | Discord/Telegram/Webhook channel tabs; Web Push subscribe/unsubscribe; Telegram Chat ID detection and command toggle; 80+ alert toggles and numeric thresholds; save/test; notification history refresh |
| Settings | Theme/layout controls; system diagnostics; connection form with restart badges; secure backup/download/staged restore; report schedule/run/history; frontend polling configuration/reset; server sampling/retention/toast settings |
| WiiM | Player transport, progress, volume/mute, loop and source controls; history chart/ranges/CSV/clear; alert thresholds; six sub-tabs; DSP/EQ/source/Bluetooth/stream/group/system operations; accessory refresh; device/network details |
| UPS | Hero and detail status; voltage/load charts; two independent 10m/30m/1h/6h/24h/7d ranges; CSV; outage table; PPB native event log; connection guidance |

## Component/state inventory

- 185 static buttons plus dynamic row/action buttons
- 185 static inputs: text, password, number, checkbox, range and file
- 10 selects
- 6 static data tables plus dynamically rendered table/list content
- 16 charts
- 3 global modals: client detail, SMART detail and Docker logs
- 1 global toast with existing server-configured duration
- Tabs: Cloud (4), notification channel (3), WiiM operations (6)
- Search/filter: clients search; threat search, severity, category and time; NAS
  log severity; chart time ranges throughout
- Loading/empty/error states: content text is classified by the existing
  `syncLoadingState()` observer; chart hosts use a separate loading overlay
- Disabled/readonly/permission states: existing DOM conditions, role checks and
  server-side authorization remain authoritative
- No frontend pagination exists in the current console; the redesign must not
  invent backend pagination or alter existing bounded result sets
- No WebSocket exists in the current console
- NAS Monitor uses one existing `EventSource('/api/nas/stream')`

## Network and refresh contract

The redesign must not change the following behavior.

- `fetch()` is wrapped only for the existing same-origin CSRF/session boundary
- Page navigation calls the existing `sendHeartbeat(true)` and
  `applyPolling(true)` paths
- Focused device pages keep the existing 3-second effective polling interval
- Device-view heartbeat stays at 5 seconds
- Background/common critical alert polling stays at 10 seconds
- Existing default job intervals remain unchanged:
  - 5s: WiiM playback, heartbeat
  - 10s: critical alerts
  - 15s: UCG hardware, threats
  - 30s: clients, NAS, Docker, trends, notification log, report log,
    system diagnostics, security settings, WiiM system, UPS
  - 60s: AdGuard, UCG history, switch matrix, ISP metrics
  - 120s: Linux host, Cloud, NAS advanced, PPB events
  - 300s: UCG spike analysis
- Poll jobs stop when their page is not active, except existing common jobs
- Visibility handling, focus release and activity scopes remain unchanged
- NAS SSE continues to refresh alerts on each received event
- WiiM progress continues its existing local one-second display tick without
  adding requests

The frontend currently references the same-origin API families for authentication,
CSRF, UI preferences, heartbeat, clients, threats/security, WiFi, Cloud, hardware,
NAS/Docker/SSE, AdGuard, Linux, notifications/Web Push, settings/connections,
backup/restore, reports, WiiM and UPS. Endpoint strings, methods, payloads, query
parameters, headers and invocation timing are regression-protected.

## Pre-redesign verification

- `npm run check:css`: pass
- `npm test`: 689 passed, 0 failed
- Build/lint/typecheck scripts: not defined separately in `package.json`
- Mock baseline: isolated current-source server on `http://127.0.0.1:3015`
- Desktop baseline: 1440x1000
- Tablet baseline: 820x1180
- Mobile baseline: 390x844

Visual baseline files are stored outside the repository:

- `before/overview-desktop.png`
- `before/overview-tablet.png`
- `before/overview-mobile.png`

Observed baseline issues to fix without changing behavior:

- tablet/mobile topbar actions are clipped
- mobile content has page-level horizontal overflow
- mobile KPI and device cards exceed the viewport
- many controls depend on per-element Tailwind colors rather than one coherent
  login-aligned console token system
- the existing glass treatment is brighter/bluer and more card-uniform than the
  restrained steel/graphite login system
- focus, modal and status foundations exist but need a complete visual pass and
  more consistent control sizing

## Regression checklist

After each phase, verify:

- all 14 navigation targets and original menu order
- existing button handlers and role visibility
- clients search, row keyboard activation, rename and block controls
- threat filters/search/export/block controls
- WiFi QR and SSID controls
- Cloud and WiiM tabs
- NAS tables, actions, SSE state and three modals
- notification/settings forms and exact save payload tests
- chart ranges, legends, tooltips and downloads
- toast timing and trigger behavior
- logout, theme, layout editing, mobile drawer and Escape handling
- no additional API request, polling job, EventSource, worker or device probe
- desktop, tablet, mobile, 200% zoom and reduced motion

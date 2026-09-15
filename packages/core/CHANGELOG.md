# @wbaw/core

## 0.8.2

### Patch Changes

- Fix check-in status always showing "not claimed yet" after every refresh
  
  The status read on `/billing/meter/checkin-status` reports the seasonal
  check-in ACTIVITY, not the daily bonus, so with no activity running the
  gateway returns the whole block zeroed (`active:false`,
  `activity_name:""`, `start_time`/`end_time`:""`) — `today_checked_in`
  included. Reading that flag as the daily verdict therefore rendered
  "not claimed yet" for accounts that had already claimed, and every
  `refreshAllUsage()` (startup warm-up, Refresh usage, tray, region-follow
  refresh after a chat, midnight rollover) re-read it and erased the
  correct verdict a claim had just established.
  
  - `fetchCheckinStatus` now reports `unknown` when no activity is running
    instead of inventing `unclaimed`.
  - `ensureCheckin` falls through to the (idempotent) claim endpoint
    whenever the status read is not a confirmed "claimed", so an
    inconclusive read can no longer silently skip the daily claim.
  - `refreshAllUsage` keeps a verdict the claim recorded today, and stops
    preserving one from a previous day — so a new day always re-offers
    the bonus.
  - The sidebar "Check in all" button now counts accounts whose cluster
    has check-in enabled and that are not confirmed claimed, so it stays
    actionable on hosts that do not auto-claim and after a failed claim.

## 0.8.1

### Patch Changes

- Chat through the international cluster works again. The gateway rejects any
  payload whose first message is not `system` (`400 / 11128`), and VS Code folds
  its own system prompt into the first *user* message — so nothing upstream
  guaranteed the shape it wants. A leading `system` message is now inserted when
  missing, empty on purpose: the gateway is asking for the shape, and inventing
  text there would override the editor's own instructions. Measured against the
  live gateway — CN tolerates both shapes, INTL requires `system` first, and CN
  accepting it too is what keeps this unconditional instead of region-gated.
  
  The status bar now follows the model group you are actually chatting with.
  Sending through the Global group switches the tracked region, so the quota on
  screen — and the management page's segment, and the model-group figure — belong
  to the cluster that just served the request, rather than to whichever region was
  selected last. Switching a region re-reads quota for every account, so the
  number is the new cluster's, not a stale carry-over.
  
  Both region catalogues are warmed at startup. Previously `init()` warmed only
  the active account's region, so the other model group stayed empty until you
  happened to sign in or refresh on that side. Warming is deliberately sequential:
  running the two fetches in parallel made them race on the credential store's
  read-modify-write, and one region silently collapsed to an empty list.
  
  The hover card is rebuilt: one row per region with its own balance bar, the
  check-in state, and real buttons instead of text links. Its palette follows the
  active colour theme (an SVG inside `<img>` cannot read the host's CSS variables,
  so a fixed palette was invisible on light themes). Under auto-select the rows
  show region totals, and the card says so; otherwise they show the region's
  active account.

## 0.7.1

### Patch Changes

- Lock all three workspace packages at the same version (0.7.0) under changesets fixed-versioning. Root `package.json` is the single source of truth; `yarn version-packages` keeps every workspace in sync.

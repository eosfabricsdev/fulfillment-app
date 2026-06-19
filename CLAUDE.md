# CLAUDE.md — EOS Fabrics Fulfillment Cut List

> **⚠️ SESSION-END PROTOCOL (read first):** Before ending any session that changed
> code, decisions, or understanding, append a dated entry to the
> [Session Log](#session-log) at the bottom of this file: what we did, why, and any
> context the next session needs. This file is auto-loaded into context every
> session, so keep it accurate. Update the body sections above when architecture
> changes — don't let the log contradict the docs.

## What this is

A Shopify **embedded admin app** that drives the warehouse fabric-cutting workflow
for EOS Fabrics. Staff see a prioritized "cut list" of unfulfilled order line items,
scan each item's barcode/SKU to verify it, print bin + cut labels, and the app
tracks cut progress. It also logs per-cutter productivity.

- Deployed: `https://fulfillment-app-two.vercel.app` (Vercel)
- Shopify app client_id: `dd9eccba58a0c0d4601acf0040dd2116`
- Admin API version: `2026-07`

## Tech stack

- **React Router 7** (framework mode, `flatRoutes` file routing) — not Remix, though similar
- **Shopify App** via `@shopify/shopify-app-react-router`, embedded with App Bridge
- **Polaris web components** — UI uses `<s-*>` custom elements (`s-page`, `s-section`,
  `s-box`, `s-stack`, `s-badge`, `s-table`, `s-clickable`, etc.), NOT Polaris React
- **Prisma + PostgreSQL** (`DATABASE_URL`) — sessions + cut-event logging
- **GraphQL Admin API** for all order/product reads and tag mutations
- Node `>=20.19 <22 || >=22.12`

## Architecture / key files

| File | Role |
|---|---|
| [app/routes/app._index.tsx](app/routes/app._index.tsx) | **The app.** ~3,700 lines — loader, action, and the entire cut-list UI. Almost all work happens here. |
| [app/routes/print-label-both.tsx](app/routes/print-label-both.tsx) | Standalone print page. Renders 57mm×25mm bin + cut labels with CODE128 barcodes (JsBarcode via CDN), auto-prints, auto-closes. |
| [app/routes/app.history.tsx](app/routes/app.history.tsx) | 30-day cut-productivity report (per-cutter + daily totals) from `CutEvent`. |
| [app/routes/app.diagnose.tsx](app/routes/app.diagnose.tsx) | Debug route — runs several order queries to diagnose why an order is/isn't visible. |
| [app/routes/app.tsx](app/routes/app.tsx) | App Bridge shell / nav. |
| [extensions/cut-list/src/ActionExtension.tsx](extensions/cut-list/src/ActionExtension.tsx) | Shopify **order admin action** extension (~1,500 lines). |
| [prisma/schema.prisma](prisma/schema.prisma) | `Session` + `CutEvent` models. |

## Core concepts (important — non-obvious)

- **State lives in Shopify order tags, not the DB.** Cut/print progress is encoded as
  order tags and parsed back on every load. Key tag conventions:
  - `picked` — order fully cut; `partially picked` — some lines cut
  - `printed` — bin label printed for the order
  - `picked:<numericLineId>_<sku>` — a specific line item was cut (written via
    `pickedLineTag()`, capped at 40 chars; legacy `picked-line:` tags are still matched).
    Match with `isPickedLineTagFor()` / `isAnyPickedLineTag()` — never hand-roll the prefix.
  - `cut-by:<numericLineId>_<employeeName>` — who cut it
  - `ready-to-ship:<numericLineId>` — line marked ready to ship
  - `skipped:<numericLineId>` — line skipped/held
  - Eastern-time timestamp tags (`YYYY-MM-DD HH:MM AM/PM TZ`) record when cut
  - `rush`, `multiple orders`, `local pickup` — order-level routing tags
- **Optimistic UI + protected-order window:** local state updates immediately on
  mutation; `recentMutationsRef` protects an order for **60s** so the background
  revalidator doesn't overwrite optimistic changes. See the merge logic in the big
  `useEffect` near the top of the component.
- **Auto-refresh:** revalidates every **30s** (skipped while typing / modal open /
  preview open) and on tab focus/visibility.
- **The one piece of persistent app data is `CutEvent`** (cut log), written by the
  `logCut` action intent. Everything else is derived from Shopify.
- **The app never fulfills orders** — it only writes order *tags* (`tagsAdd`/`tagsRemove`
  are the only mutations). Real fulfillment happens downstream (EasyScan / staff). So a
  cut line stays `unfulfilled` in Shopify forever; the cut list hides it purely via the
  client `pickedItems` set + the round-tripped `picked-line:` tag (`persistedPicked`).
- **Client→action POSTs MUST use React Router's submission APIs** (`fetcher.submit` /
  `useSubmit` / `<Form>`), never a hand-rolled `fetch()` to the route URL. This app is
  React Router 7 (single fetch): a raw `fetch("POST", "/app")` is matched to the
  **layout** route `routes/app` (which has no `action`) and returns **405 Method Not
  Allowed** — it never reaches the `app._index` action. The fetcher targets the correct
  route's action via the data path. The silk resolver POSTs to its own resource route
  [api.silk-substitutes.tsx](app/routes/api.silk-substitutes.tsx) (direct `fetch` is fine
  for resource routes).
- **Shopify caps order tags at 40 characters, and over-length tags are silently
  rejected (the mutation returns HTTP 200 with `userErrors` — no thrown error).** This
  was the root cause of the long "cut items vanish" saga: `picked-line:<14-digit-id>_<sku>`
  exceeded 40 chars for longer SKUs (e.g. swatches), so Shopify dropped the whole write
  and the line had no tag → reappeared / vanished. Tags are built via `pickedLineTag()`
  (caps at 40, preserves the `picked-line:<id>_` prefix needed for matching) and `cut-by`
  names are truncated. The [api.order-tags.tsx](app/routes/api.order-tags.tsx) action
  checks `userErrors` and returns 422 so this can't silently recur. **Keep any new
  order tag ≤ 40 chars.**
- **All tag/cut writes go to the [api.order-tags.tsx](app/routes/api.order-tags.tsx)
  resource route via `enqueueWrite()`, queued PER ORDER.** This is the heart of the cut
  flow's reliability. Two earlier approaches both failed:
  - A single shared `useFetcher` → rapid successive cuts *cancel* each other's in-flight
    submits → dropped writes.
  - Independent concurrent submissions → multiple writes to the *same order* hit Shopify
    at once, and tag mutations are read-modify-write, so they *race/clobber* (lost
    updates) → inconsistent tags (e.g. some `picked-line:` but no `picked`).
  The fix: `enqueueWrite()` chains a per-order promise queue and `fetch`es the resource
  route (awaitable; a raw POST to `/app` 405s under single fetch). Same-order writes run
  one-at-a-time (no race, no cancel); different orders run in parallel. **Any new
  order-tag write must go through `enqueueWrite` — never fire concurrent same-order tag
  mutations.**
- **Call the submit synchronously inside the event handler — never after an `await`.** A
  submission deferred to a microtask (e.g. `await resolveSilkSubstitutes(...)` before the
  tag write) is also dropped. In `openPrint`/`printSwatchBundle` the cut is recorded first
  (tags + `submitLogCut`), then substitutes resolve and the print window opens. The cut
  must not depend on substitute resolution.
- **`VIRTUAL_SKU = "85496775805861"`** is filtered out everywhere (a non-physical line).
- **Silk swatch substitution:** silk swatches (not Crepe de Chine, color ≠ 101) get
  substitute labels resolved server-side via the `resolveSilkSubstitutes` action,
  which anchors on SKU `41031` (CDC) and matches by `color_code` metafield.
- **SKU anchor times** (localStorage `skuAnchorTimes`) keep same-fabric items grouped
  in sort order even as new orders arrive.

## Loader queries (app._index)

- Main list: `(fulfillment_status:unfulfilled OR on_hold OR partial) -status:cancelled -tag:picked -tag:'picked by EasyScan'`
- Picked today: `(tag:picked OR tag:'partially picked') -fulfillment_status:fulfilled`
- Line items pull `bin_number` and `color_code` from the `custom` metafield namespace.
- Also fetches `currentStaffMember` to attribute cuts (`employeeName`).

## Action intents (app._index)

`logCut`, `tagsAdd`, `tagsRemove`, `tagsUpdate` (remove+add in one call),
`resolveSilkSubstitutes`.

## Filters / buckets

`all`, `rush`, `rollEnds`, `swatches`, `totalSwatches`, `pickedToday`, `multiple`,
`hold`, `readyToShip`, `localPickup`. Each has its own sort (customer batching,
SKU grouping, rush-first, etc.).

## Access scopes

`write_metaobject_definitions, write_metaobjects, write_products, read_orders,
write_orders, read_products, read_merchant_managed_fulfillment_orders, read_customers`

## Dev commands

```bash
npm run dev          # shopify app dev (tunnel + local)
npm run build        # prisma generate && react-router build
npm run deploy       # shopify app deploy (extensions/config)
npm run setup        # prisma generate && prisma migrate deploy
npm run lint
npm run typecheck    # react-router typegen && tsc --noEmit
```

Note: `app._index.tsx`, `app.history.tsx`, `app.diagnose.tsx` use `// @ts-nocheck`.

## Known quirks / cleanup candidates

- Leftover debug logging: `console.log("[refresh] …")` in the 30s refresh effect
  (~[app._index.tsx:1222](app/routes/app._index.tsx#L1222)) and `[silk] …` logs in the
  substitute resolver. Probably should be removed.
- `getFilteredItems()` has a duplicated/unreachable `multiple` branch (handled early,
  then again later).

## Session Log

> Newest first. One entry per working session. Keep it short: what changed, why, and
> any thread the next session should pick up.

### 2026-06-17
- **Context recovery / onboarding.** No prior memory or CLAUDE.md existed, so prior
  conversation history was not persisted. Read the full codebase and git history to
  rebuild understanding of the app. Created this CLAUDE.md and the session-end protocol.
- **Fixed: cut items reappearing on the list after ~60s (client bug report).**
  - Root cause: yesterday's commit `2de9960` switched all writes from
    `tagFetcher.submit()` to raw `fetch(window.location.pathname, …).catch(()=>{})`.
    `window.location.pathname` drops the embedded-auth query params, so every
    tag/cut/silk-resolver POST was silently bounced by `authenticate.admin` — no tags
    were written. The optimistic UI + 60s protection window masked it for ~a minute,
    then the still-unfulfilled line reverted onto the list.
  - Confirmed via a live order: after a cut it had **none** of the expected tags (only a
    stale May-21 ISO timestamp from an older build).
  - Why the switch happened: `useFetcher` is a single instance, so rapid successive
    `submit()`s cancel each other → dropped writes during fast scanning. Raw parallel
    `fetch` fixed that; the URL was the mistake.
  - **First fix attempt was WRONG** (committed + deployed): added `actionUrl()`/
    `postAction()` posting via raw `fetch(pathname + search)`. The local 90s "pass" was
    just the 60s protection window masking it. Live + test both still failed — DevTools
    showed `POST /app… 405 (Method Not Allowed)` and Vercel logged *"POST request to /app
    but did not provide an action for route routes/app."* Raw fetch can't reach a
    React Router 7 action (single fetch); it hits the layout route which has no action.
  - **Real fix:** reverted the four writes to `tagFetcher.submit()` /
    `cutLogFetcher.submit()` (the pre-yesterday mechanism). Removed `actionUrl`/
    `postAction`. Silk resolver left on raw `fetch` (still 405s, degrades gracefully).
  - Lesson recorded in Core concepts: never hand-roll `fetch` POSTs to route actions here.
- **Fixed: silk substitute resolver (was 405-ing pre-existingly).**
  - Created resource route [api.silk-substitutes.tsx](app/routes/api.silk-substitutes.tsx)
    (action-only, no UI) that returns `Response.json({ ok, results })`. Moved the silk
    GraphQL logic there out of the `app._index` action; removed the
    `resolveSilkSubstitutes` intent from that action.
    `resolveSilkSubstitutes()` now `fetch`es `/api/silk-substitutes` + search. A direct
    `fetch` works because resource routes (no default export) are served directly, not via
    the single-fetch UI path.
  - Both fixes build clean (`npm run build`).
  - **Verified (local):** regular cut item — tags persist on the order and the line stays
    off the cut list (in Ready to Ship) after 3 min. Silk-swatch substitute case still
    unverified at last check; push pending.
- **Fixed: swatch cuts not persisting (regression surfaced during silk testing).**
  - Symptom: cut a swatch → leaves list → after ~90s returns, and the order had **zero**
    tags. Console showed `[silk] items needing substitute 0` and no network call, so the
    resolver wasn't the cause.
  - Root cause: `printSwatchBundle` always did `await resolveSilkSubstitutes(...)` *before*
    the tag writes, so `tagFetcher.submit()` ran in a post-`await` microtask and was
    dropped. Non-swatch `openPrint` worked only because its silk ternary short-circuits to
    a synchronous `new Map()` (no await) for normal items.
  - Fix: in both `openPrint` and `printSwatchBundle`, record the cut synchronously first
    (tag writes + `submitLogCut`), then `await` substitutes and open the print window.
    Recorded the rule in Core concepts. Builds clean.
  - Also confirmed: bin-label sequence now correct (swatch → both, first non-swatch →
    both, later non-swatch → product only). Verified by user.
  - **Pending:** user retest of swatch persistence past 90s; silk substitute *labels*
    still need a store that has the CDC anchor (SKU 41031) + color-101 variants to verify.
- **Fixed: cut lines reappearing on multi-item orders (shared-fetcher cancellation).**
  - Definitive evidence: a temporary `[persist-debug]` log on order #1026 (4 lines) showed
    3 lines had their `picked-line:` tag and `matched: true` (stayed hidden); the 4th had
    **no** `picked-line` tag and `matched: false` (reappeared). `persistedPicked` was
    working — the tag was simply never written. The order also had no `partially picked`/
    `picked`. Cause: all writes shared one `useFetcher`, so rapid successive cuts cancelled
    each other's in-flight submissions.
  - First fix (independent `useSubmit` + unique `fetcherKey`) stopped the cancellation but
    INTRODUCED a race: concurrent same-order tag mutations clobbered each other. Order
    #1027 ended up with the 3 non-swatch `picked-line` tags but no `picked`/`partially
    picked` and no swatch line → swatch reappeared on the cut list, the 3 non-swatch items
    vanished from every view (hidden from cut list, absent from Picked Today/Ready to Ship
    because the order had no order-level tag).
  - Interim fixes (real but not the cause): writes → `api.order-tags` resource route +
    `enqueueWrite()` per-order serial queue (avoids fetcher-cancel AND concurrent-mutation
    races); writes-before-await in print fns. Keep all of these.
  - **ACTUAL ROOT CAUSE (found via `[order-tags]` logging on a live cut):** the swatch's
    tag was `picked-line:16540616687875_Fabric_E_swatch` = **42 chars > Shopify's 40-char
    tag limit** → silently rejected (HTTP 200 + userErrors) → no swatch tag → swatch
    reappears; and when the swatch was the final cut, its over-length tag was in the
    `picked` add-batch so `picked` was lost too. See Core concepts.
  - **Fix:** `pickedLineTag()` caps the tag at 40 (keeps SKU per client request, preserves
    matching prefix); `cut-by` name truncated; resource route surfaces `userErrors` (422).
    Verified by user: freshly cut multi-item order persists in Ready to Ship across many
    refreshes.
  - **Follow-up (client request — more SKU room):** shortened the cut-line prefix from
    `picked-line:` (12 chars) to `picked:` (7) → ~18 chars for SKU instead of 13.
    Centralized into `PICKED_LINE_PREFIX` + `isPickedLineTagFor()`/`isAnyPickedLineTag()`;
    matching still accepts legacy `picked-line:` tags so in-flight orders don't break.
    Safe vs `-tag:picked` (Shopify `tag:` is exact-match). Builds clean; pending user retest.
  - Cleanup tracked: the now-dead `app._index` `action` (tag/logCut handlers) — all writes
    go to the resource route; safe to delete later.
- **Fixed: silk swatch substitution (`substituteA` never resolved).** Verified live.
  - `resolveSilkSubstitutes` builds two labels per silk swatch: **substituteA** = Crepe de
    Chine swatch in the *ordered color*; **substituteB** = the *ordered quality* in color
    101. substituteB worked; substituteA was always missing.
  - Root cause (found via temp `[silk] debug` logging on a live cut): the CDC "By the Yard"
    and "Swatch Sample" products **share SKU 41031**. The query did
    `productVariants(first: 1, query: "sku:41031")` → locked onto the by-the-yard product →
    pulled only by-the-yard variants → zero swatch samples → substituteA never found. (Color
    codes were never the issue — CDC uses the same numeric scheme, 101–198.)
  - Fix: query `productVariants(first: 250, query: "sku:41031")` to get ALL variants with
    that SKU (both products), then `findSwatch` picks the Swatch Sample in the ordered color.
    Verified: `cdcSwatchCount` 98, both labels print. Note: capped at 250 variants for that
    SKU (~196 today across the 2 CDC products); revisit if a 3rd product ever shares it.
- **Added: order note auto-opens on line activation.** The note modal now opens when a
  cutter activates a line whose order has a note (effect on `activeLineId`), shown once per
  order via `acknowledgedNotes`; the NOTE badge still reopens it. Removed the old scan-time
  trigger so it can't double-pop (per user — wasted time).
- Open threads:
  - **Hydration mismatch (pre-existing, separate):** timestamps render differently on
    server vs client (`toLocaleString()` → `Server: "6/11..." Client: "6/15..."`), forcing
    React to discard SSR and re-render client-side. Console-noisy; fix by rendering dates
    deterministically / `suppressHydrationWarning` on the timestamp text. Not the cause of
    the cut bugs.
  - Tracked/untouched per user: leftover `[refresh]`/`[silk]` debug `console.log`s;
    duplicate `multiple` branch in `getFilteredItems()`.

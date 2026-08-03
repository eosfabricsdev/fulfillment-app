# CLAUDE.md — EOS Fabrics Fulfillment Cut List

> **⚠️ REGRESSION GUARD — LOCKED FUNCTIONS (read first, applies to EVERY change):**
> This app runs a live warehouse; the client has repeatedly been burned by an update
> silently removing or altering a feature that was NOT meant to change. Before making
> ANY edit, actively check whether it could touch behavior beyond its stated intent —
> especially the **locked functions** below — and if it *might* clash with, remove, or
> change one **unintentionally, STOP and flag it to the user to decide together.** Do
> not "clean up" or refactor adjacent behavior in passing. When in doubt, call it out.
>
> **Locked functions** (change ONLY when explicitly asked, and say what you're touching):
> the cut→tag→print flow and its tag conventions; the per-order `enqueueWrite` queue;
> the 30s/focus auto-refresh (and its no-`document.hidden`/barcode-text-typing rules);
> 401 handling via `boundary.error` (no raw reload); swatch bundling; roll-end = normal
> print flow; filter-card count definitions; the activation alert (note re-pop + inventory
> warning); new-tab reference links; `graphqlWithRetry`; **RUSH-TO-TOP sorting** (rush
> orders + items sharing a rush order's SKU float ABOVE the chronological queue — must
> never be displaced, including by the SKU position-lock); the **SKU position-lock** +
> within-group auto-advance. See the body sections for each. NOTE (2026-07-21): the
> position-lock's whole-list-freeze once broke rush-to-top — anything layered over the
> sort MUST re-float rush to the top.
>
> **⚠️ SESSION-END PROTOCOL:** Before ending any session that changed
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
| [app/routes/print-label-both.tsx](app/routes/print-label-both.tsx) | Standalone print page. Renders 57mm×25mm bin + cut labels with CODE128 barcodes (JsBarcode **bundled locally**, pinned 3.11.6 — was CDN, changed 2026-07-30), auto-prints, auto-closes. |
| [app/routes/app.history.tsx](app/routes/app.history.tsx) | 30-day cut-productivity report (per-cutter + daily totals) from `CutEvent`. |
| [app/routes/app.bin-barcode.tsx](app/routes/app.bin-barcode.tsx) | **"Bin & Barcode" tab** (added 2026-07-30). **Running-list batch flow** (2026-07-31): scan/type multiple barcodes/SKUs into a list, then **Replace** or **Add** ONE `custom.bin_number` to all at once (EasyScan-style; e.g. consolidating roll ends). Own loader+action (leaf route); batch write via `nodes` read + chunked `metafieldsSet` (25/call). More tools planned for this tab. |
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
- **Auto-refresh:** revalidates every **30s** and on tab focus/visibility, via
  `primeTokenAndRevalidate` (which best-effort refreshes the App Bridge session token
  before revalidating, capped by a **2s timeout race** so a hung `window.shopify.idToken()`
  can't freeze the refresh). The 30s tick skips only when **a barcode field actually has
  text** (a real in-progress scan) or a modal/preview is open. **Hard-won gotchas (see
  2026-07-16 log):**
  - Do NOT gate the interval on `document.hidden` — it reads `true` in the embedded iframe
    even while on-screen and silently kills the refresh.
  - Do NOT infer "typing" from `document.activeElement`/`contenteditable` — the scan field
    is a Polaris `<s-text-field>` that is ALWAYS focused and reports `contenteditable=true`,
    so that heuristic thinks the cutter is perpetually typing. Use barcode-text state.
  - Do NOT `await idToken()` unconditionally — it can hang on a stale session and freeze
    the refresh; always race a timeout.
  - The **"Last updated" counter resets on every completed revalidation** (revalidator-state
    effect), not just on data change — so a visible-but-quiet screen still ticks 1→30→1 as
    proof it's live-polling.
- **401 handling:** the loader's own errors go to Shopify's built-in `boundary.error`
  (app._index `ErrorBoundary` just returns it) — the framework's proper App Bridge
  re-auth. Do NOT catch a 401 and `window.location.reload()`: a raw reload re-requests the
  iframe with the ORIGINAL, now-stale embedded params (id_token/hmac/timestamp) and itself
  returns the bare white "401 Unauthorized" page. Some bare 401s are document-level (React
  not mounted) and can't be caught in-app — a one-time manual reload is the fallback.
- **Transient Shopify errors:** loader GraphQL calls go through `graphqlWithRetry`
  (3 attempts, 300/600ms backoff) so a momentary Shopify **503 "Service Unavailable"**
  self-heals instead of white-screening. Sustained outages still fail (reload later).
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
- **Filter-card count conventions (audited 2026-06-29 against client intent).** Each
  summary card has a deliberate unit — don't "simplify" them to all match:
  - *Rush Orders* — unique **orders** carrying the rush label (`new Set(rushOrders.map(
    orderId)).size`), NOT line items (fixed 2026-07-21 — was `rushOrders.length`, which only
    looked right while rush orders had one line each). The `rushOrders` memo stays
    line-item-level for the rush filter list + rush-to-top sort.
  - *Total Orders to Pick* — unique orders with ≥1 **uncut** line (`uniqueOrders` from
    `uncutItems`, not all items).
  - *Total Cuts to Pick* — **line items**, not unit quantity; BUT an order's swatches
    bundle into **one** cut (`nonSwatchCuts + swatchBundleOrders.size`). Mirrors the list,
    which renders all of an order's swatches as a single bundle row (the lone `return null`
    in the render map).
  - *Total Swatches to Pick* — swatch **bundles** = `swatchBundleOrders.size` (one per
    order with an uncut swatch), reused from Total Cuts so they can't drift.
  - *Roll Ends Only* / *Swatches Only* — unique orders whose **original composition** is
    entirely that type, via `getFullOrderOnlyIds(predicate)`. "Original" = evaluated over
    the full order incl. cut/ready-to-ship lines, so a mixed order reduced to one type by
    cutting never qualifies. A **roll end is detected by `isRollEnd()`** (variant/fabric
    length contains "yard piece") — NOT `productType === "roll end"`, which is a
    **deprecated** field (roll ends now carry productType "fabric by yard"). Note:
    `isRollEnd()` is ONLY for these counts/filters now — the scan→print flow does NOT
    special-case roll ends (see the print-flow bullet below).
  - *Customers with Multiple Orders* (renamed from "Multiple Orders") — unique **customers**
    (`customerId || "guest"`) tagged `multiple orders`.
  - *Local Pickup* — unique orders tagged `local pickup`, from `cutListItemsVisible`.
  - *Fulfillment Hold* — unique held orders, detected by **native `hasHold`** (Shopify
    `fulfillmentHolds`), NOT a tag (no hold tag exists). Sourced from `holdItems` =
    cut list **+ picked-today**, so a **fully-cut** held order (tagged `picked`, hence
    excluded from the main query) still shows — a held order can't ship, so unlike Local
    Pickup it must NOT drop off when fully cut.
  - *Ready to Ship* — unique orders fully `picked` **or** with a per-line `ready-to-ship`
    tag (single items are promoted manually — intentional), excl. holds / READY_FOR_PICKUP.
  - *Orders Cut Log* — unique **partially-picked** orders; *Items Cut Log* — cut **line
    items** in those orders. (A partially-picked order shows in both Total Orders to Pick
    and Orders Cut Log by design.)
- **One scan→print flow for every product EXCEPT swatches.** After a scan verifies a line
  (`readyToPrint`), a normal product shows **Print Labels** (bin + product/cut labels, first
  time) → **Print Product Label** (`openPrint(item, !alreadyPrinted)`). Roll ends use this
  **identical** flow — they are NOT special-cased in the print buttons (client request
  2026-07-16; the old bin-label-only roll-end branch was removed). Swatches are the only
  exception: they render as one **bundle row** (`isBundleRow`, checked *before* the
  `readyToPrint` branch) with their own **Print Swatch Labels** flow. So: swatch → bundle
  flow; everything else → the shared normal flow.
- **Activation note pop-up + inventory badge** (as of 2026-07-21 the inventory warning is
  BADGE-ONLY — no modal). On EVERY line (re)activation (`activeLineId` change, tracked by
  `prevNoteLineIdRef` so the 30s refresh doesn't re-pop it), the note modal opens **only if
  the line has an order note** (`noteModalContent`; `📝 NOTE` badge also reopens it).
  - *Inventory warning* — shown ONLY as a passive `⚠️ CHECK INVENTORY` badge on the row
    (no modal, no auto-pop — client decided the badge is sufficient). Driven by
    `hasInventoryWarning(item)` = `inventoryQuantity != null && inventoryQuantity <= 0`,
    **excluding swatches and roll ends** (one-off/sample stock naturally near 0).
    `variant.inventoryQuantity` is **available** stock (already net of commitments), so
    `<= 0` IS "this cut brings the fabric to 0/negative" — do NOT subtract the line
    quantity again (double-count). Replaces a Shopify Flow the client is removing; the app
    is now the source of truth, live via the 30s refresh. NOTE: `noteModalContent` still
    carries an inert `inventoryWarning` field + a dead modal section — never set true now.
- **Reference links open in a NEW TAB, on purpose.** Product/SKU/order/customer links use
  real `https://admin.shopify.com/store/<handle>/...` URLs (built by `adminUrl()`, from
  `data.shop`) with `target="_blank"` — NOT `shopify://admin/...` App Bridge deep links.
  Deep links drive the *parent* admin, which navigates the whole embedded app away and
  makes the cutter lose their place mid-cut (client complaint). Don't "simplify" these
  back to `shopify://` — and note the shopify:// scheme can't resolve in a fresh tab
  anyway, so a new tab requires the full https URL.

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

- Leftover debug logging: ~~`console.log("[refresh] …")` in the 30s refresh effect~~
  **removed 2026-07-09** while reworking that effect; `[silk] …` logs in the substitute
  resolver still remain and could be removed.
- ~~`getFilteredItems()` has a duplicated/unreachable `multiple` branch~~ — **removed
  2026-06-29** (along with the dead `buildStrictOrderMap` + `orderMap` once the count
  helpers were centralized).
- **Order visibility is capped at the last ~60 days** because the app has `read_orders`
  but not `read_all_orders` — older orders never reach the loader (e.g. a >90-day rush
  order shows 0 on the cut list / Rush card). Fix = request the protected `read_all_orders`
  scope (Shopify approval + merchant re-consent), then add it to `shopify.app.toml`.
- ~~**Cut History shows every cutter as "Unknown"**~~ — **FIXED 2026-07-30 (verified in dev;
  resolved a real name).** Root cause was offline (app-level) tokens: no user identity, so
  `currentStaffMember` returned null and `employeeName` fell back to "Unknown". **Fix: a
  SCOPED, read-only online-token exchange in the app._index loader** — NOT an app-wide switch
  to online tokens. `authenticate.admin(request)` returns the decoded `sessionToken` (whose
  `.sub` = the acting user's id); we exchange the raw session token for an ONLINE access token
  and read `associated_user.{first_name,last_name}` for the name.
  - **Done via a DIRECT `fetch` to `https://<shop>/admin/oauth/access_token`** (grant_type
    token-exchange, subject_token_type id_token, requested_token_type online-access-token,
    client_id/secret from `process.env.SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`). NOTE: the
    library's `api.auth.tokenExchange` is NOT usable here — `shopify.api` is undefined on the
    public `shopifyApp` return (the `api` prop is on the internal `BasicParams` type only). So
    we build the same request the library does. `RequestedTokenType.OnlineAccessToken` =
    `"urn:shopify:params:oauth:token-type:online-access-token"`.
  - The app's PRIMARY auth stays offline/unchanged; the online token is **never stored** (we
    read the name and discard); any failure falls back to "Unknown" (identical to before), so
    it can't destabilize the (now-fixed) 401/200 auth path. No new scope; the exchange is
    silent (no re-consent).
  - Raw session token via `getRawSessionToken()` (Bearer header on data reqs / `id_token`
    param on document reqs). Names cached per user id (`cutterNameCache` module map) so the
    exchange runs at most once per cutter per server instance, not on every 30s revalidation.
  - GOTCHA: `employeeName` is captured once on client mount (`useState(data.employeeName)`),
    and PAST `CutEvent`s keep their old "Unknown" — only NEW cuts after a fresh load get the
    name. Testing a loader change here needs a dev-server restart + hard reload.
  - **Still worth confirming with a SECOND cutter login** (two names attribute distinctly) and
    in the live store, but the mechanism is proven (resolved "Katoa Price-Ahau" in dev).
- **QUEUED (2026-07-30): `redirect_urls` / auth-path mismatch.** `shopify.server.ts` sets
  `authPathPrefix: "/auth"` (auth routes live at `/auth/*`, handled by `auth.$.tsx`), but
  `shopify.app.toml` declares `[auth] redirect_urls = ["https://fulfillment-app-two.vercel.app/api/auth"]`
  — a route that **doesn't exist** (stale value from an older template). Currently **dormant/
  harmless** because the app authenticates via **token exchange** (App Bridge session token),
  which never uses the OAuth redirect; but a fresh **install/reinstall** or a **scope change**
  could invoke the redirect flow and hit the dead `/api/auth` → install/re-grant failure. NOT
  the cause of the "200"/401 (that was the session-token bounce, fixed by the 1.2.1 upgrade —
  see 2026-07-30 part 2). **Fix = point `redirect_urls` at the real `/auth` callback path the
  1.2.1 library expects** (verify the exact path first), then **`shopify app deploy`** to push
  the config to Shopify (a code push alone won't update it). Touches auth config + needs a
  config deploy, so do it as its own carefully-tested change (`shopify app dev` first).
  **Deferred by client 2026-07-30** — park until the current deploy is watched for a few days.

## Session Log

> Newest first. One entry per working session. Keep it short: what changed, why, and
> any thread the next session should pick up.

### 2026-08-03
- **NEW: "Reprint last cut" strip** (client request — crash-proof freeze recovery). Sits in the
  open space to the right of the search bar; shows **Order No · Product Title · SKU** + a
  **Reprint** button (reprints BOTH bin + product labels in one window). Source is the
  **persistent `CutEvent` DB, read in the loader** (`prisma.cutEvent.findFirst`, most recent for
  the current cutter by `cutterName`, falls back to most-recent-for-shop if name unknown) → so it
  **survives a browser close/crash/relogin** (it's DB-derived, NOT client state like undo). The
  loader returns `lastCut {orderName, lineItemId, sku}`; the client matches `lineItemId` to a
  loaded `pickedTodayItems`/`cutListItems` entry to get Product Title + full reprint data. Does
  NOT touch the locked `openPrint`/cut flow. Refreshes on revalidation — incl. the focus-return
  revalidation when a print window closes — so a frozen print shows up in the strip within ~1-2s.
  CAVEAT: Product Title + the Reprint action need the item still in the loaded lists (true right
  after a cut; if the order later ships/drops, button disables but Order#/SKU still show). Build
  clean. Pending push.
- **Print freeze recurred ONCE (down from several/day) — added a fallback auto-close to the
  print window.** Anita, order 103861/93884, bin label, ~9:55 ET; window froze, she closed the
  browser to escape. Vercel logs (app's own project `prj_LMeN…`) confirm the app served every
  `print-label-both` request for that order in <20ms (200) — so app/CDN-bundle side is fine;
  the freeze is downstream in the browser→spooler→printer print hand-off. The window used to
  close ONLY on `window.onafterprint`; if that never fires (printer/spooler stalls, OR the known
  browser quirk where onafterprint doesn't fire on silent print), the window sits "stuck in
  transit". **Fix (print-label-both.tsx, additive): a 12s fallback `setTimeout(safeClose)` closes
  the window even if onafterprint never arrives** (job is already in the OS spooler by then, so
  closing doesn't cancel it); `safeClose` is idempotent. CAVEAT: cannot rescue a still-open
  NATIVE print dialog — `window.print()` blocks JS while a dialog is up — so this fully fixes it
  only if stations are set to silent/auto-print (no dialog). **Open Qs for client: is
  kiosk/silent printing configured? does the freeze show a print dialog? cluster on one
  station/printer?** Build clean. Pending push.
- **Auth fix CONFIRMED working in prod (same log pull):** zero 401s / zero error-level lines in
  the hour; at 14:03:05 UTC a session expired and 1.2.1 silently re-authed (`No valid session
  found` → `Requesting offline access token` → `Creating new session` → 200). Stations
  reboot+relogin daily, so they run current code — the earlier "401 still happened" was
  pre-fix/pre-reboot. redirect_urls/auth-path cleanup still queued.
- **Print-freeze investigation RESOLVED (decision made) — the "Open Qs" above are now answered.**
  - Client confirmed the stations use a **native print DIALOG (NOT silent printing)**, and during
    a freeze "the preview image shows in the browser window rather than the print-preview pop-up…
    no controls… it freezes the whole browser and all tabs." So this is the browser's **print-
    preview hanging**, which is browser-MODAL → **all JS in every tab freezes.** KEY CONSEQUENCE:
    **no code can rescue this freeze** — not the 12s fallback, not a watchdog, not an auto-recall/
    auto-click — because nothing executes anywhere in the browser while it's locked. The 12s
    fallback only ever helped the *milder* "window didn't close but browser still alive" case.
  - **The only thing that PREVENTS the freeze is removing the print-preview step** i.e. **silent/
    kiosk printing** (Chrome/Edge `--kiosk-printing` launch flag + label printer as Windows
    default). It acts BEFORE JS can freeze; nothing app-side can.
  - **EasyScan comparison (client asked "why never them?"):** inspected a live EasyScan print —
    it generates a **PDF blob** (`blob:https://es.506.io/…`) and opens it in the browser's **PDF
    viewer**, then prints from there. So EasyScan is NOT direct-to-printer (my earlier guess was
    wrong); its robustness comes from (a) printing a **finalized PDF** (much lighter render than
    our live-HTML `window.print()`, so it hangs far less) and (b) the label **persisting as a
    re-printable document** (never "loses the action"). Option B for us = mirror that (generate a
    PDF, open in viewer) — considered, **shelved**: doesn't kill the freeze unless paired with
    silent printing or manual-print, and porting our exact 57×25mm thermal labels + barcode
    crispness (scan-critical) + swatch-bundle/no-barcode/yards variants to a PDF lib is real
    re-test risk on the LOCKED label rendering. Never attempted historically (confirmed: no
    pdf/blob/jspdf ref anywhere in git history).
  - **CLIENT DECISION (final): accept the occasional freeze; rely on "Reprint last cut" to
    recover.** They declined silent printing for now (didn't want to configure each station) and
    did not want the PDF rewrite. So: **ship the two safety nets (12s fallback close + Reprint
    last cut strip), make NO change to the print path.** If freezes ever become intolerable, the
    on-the-shelf fix is silent printing (station config, no code) — offer it again then.
  - This session: SHIPPED the two safety nets to production (committed + pushed).

### 2026-07-31
- **Bin & Barcode → running-list BATCH flow** (client request — EasyScan-style). Replaced the
  single-item screen with a running list: each scan/Enter looks up the variant and appends it
  (auto-dedupe by variant id), then **Replace on all** / **Add to all** applies ONE bin to
  every item at once via a single batch confirm (no per-item preview — impractical at ~50
  items). Client used this to consolidate ~50 roll ends from 3 half-full bins into one.
  - Server `updateBatch` intent: one `nodes(ids:)` read of all current bins, compute per-item
    (Replace = overwrite; Add = append + case-insensitive dedupe → "already had it", no write),
    then `metafieldsSet` in **chunks of 25** (its per-call cap). Per-item results mapped back
    from `userErrors[].field[1]` index; summary = updated / already-had-it / failed.
  - **Auto-add on scan — NO Enter, NO button** (client was firm: the value landing is the only
    action). The cut list can act on `onInput` because each row knows its expected barcode/SKU
    (`value === item.barcode`); this tool is an open-ended server lookup with nothing to match
    locally, so it **auto-fires when input SETTLES**: `onScanInput` sets a debounce whose delay
    varies by input speed — `gap < 40ms` (scanner burst) → 110ms settle; slower (manual typing)
    → 650ms (keeps resetting while they type, so it won't fire mid-SKU). Enter is kept only as
    an *optional accelerator* for scanners that send an Enter suffix (fires instantly, cancels
    the timer) — never required. Lookups are **serialized via a scan queue** (one fetcher in
    flight) so rapid scanning can't drop items (the single-fetcher cancel trap); dedupe-by-id
    makes a stray double-lookup harmless. Do NOT re-introduce a required Enter/button here.
  - Client decisions: batch-wide mode only (all Replace or all Add — no per-item mix); Replace
    overwrites old bins (intended, for consolidation); list rows use small 48px thumbnails
    (the single detail view had used 150px = cut-list size). **Pending user test.**
- **Also (earlier 2026-07-31):** single-item thumbnail switched from `<s-image>` (didn't honor
  inline size → rendered large) to a plain `<img>` at 150px, matching the cut list. (Superseded
  by the running-list rows above, which use 48px, but the `<img>`-not-`<s-image>` lesson stands:
  Polaris `<s-image>` doesn't reliably size via inline style — use a plain `<img>`.)
- Note: the pushed commit `b243f73` is the SINGLE-item version; the batch rewrite is uncommitted.

### 2026-07-30 (part 5 — "Bin & Barcode" tab: update Bin Number metafield)
- **NEW tab "Bin & Barcode"** ([app.bin-barcode.tsx](app/routes/app.bin-barcode.tsx)), nav
  link added in app.tsx under Cut History. First tool: scan/type a **barcode or SKU** → looks
  up the variant (`productVariants(query: "sku:X OR barcode:X")`, takes first match) → shows
  product/image/SKU/barcode + current Bin → **Replace** or **Add** the `custom.bin_number`
  variant metafield via `metafieldsSet`, with a **preview+confirm** modal.
  - **Scope: already covered by `write_products`** (variant metafield write) — NO new scope,
    no re-consent. (Verify once in dev that the `custom.bin_number` *definition* allows app
    writes, not merchant-read-only — almost certainly yes since another app writes it.)
  - Bins are a single pipe-separated string in one `single_line_text_field` (e.g. "A2|NA"),
    NOT a list metafield. **Add** dedupes case-insensitively; a duplicate → no write + modal
    "Bin Number already on product." **Replace** overwrites. Write re-reads current bin at
    write time (authoritative read-modify-write) and reuses the metafield's existing `type`.
  - Client decisions (2026-07-30): dedupe+notice on Add; live store SKUs are always unique to
    one variant (swatches use swatch SKU, piece variants lead with 0s), so lookup safely takes
    the first match; preview+confirm required; tab named "Bin & Barcode" (anticipates a 2nd
    barcode tool the client mentioned). Build clean. **Pending user test in dev/demo.**

### 2026-07-30 (part 4 — per-cutter Cut History attribution)
- **Client wants Cut History broken down by cutter (was all "Unknown").** Implemented a
  **scoped online-token exchange** for the name, WITHOUT converting the app to online tokens
  (client explicitly asked: only for this one function, not app-wide). See the (now struck-
  through) "Cut History Unknown" item under Known quirks for the full mechanism. Key files:
  `shopify.server.ts` (exports `api = shopify.api`); `app._index.tsx` loader (destructures
  `sessionToken` from `authenticate.admin`, `getRawSessionToken()` helper + `cutterNameCache`
  module map, replaced the dead `currentStaffMember` GraphQL query with the exchange).
  Confirmed via node_modules: `@shopify/shopify-api@13.1.0`, `RequestedTokenType.OnlineAccessToken`
  = `"urn:shopify:params:oauth:token-type:online-access-token"`, and `authenticate.admin`
  returns `sessionToken: JwtPayload`. **Gotcha hit during testing:** first attempt used
  `shopify.api.auth.tokenExchange`, but `shopify.api` is **undefined** on the public shopifyApp
  return (`api` is only on the internal `BasicParams` type) → `TypeError: …reading 'auth'` →
  caught → "Unknown". Rewrote as a **direct `fetch`** to `/admin/oauth/access_token` (same
  request body the library builds, creds from env). **Verified in dev: resolved "Katoa
  Price-Ahau".** Debug logging removed. Build clean. Still to confirm: a second cutter login +
  live store.

### 2026-07-30 (part 3 — print window "freeze" fix)
- **Client "print error": scan → print window pops open → "freezes"/"stuck in transit" →
  item still leaves the list.** Reported on orders 103781/93902 (final cut, 10 AM), and
  yesterday 103796/49425 (4:54 PM), 103798/68532 (5:08 PM), 103799/91705 (5:20 PM) — different
  fabrics, intermittent.
- **Root cause:** [print-label-both.tsx](app/routes/print-label-both.tsx) loaded JsBarcode from
  the **jsdelivr CDN** via an injected `<script>`, and put ALL of barcode-draw + `window.print()`
  + `window.close()` inside `script.onload`. No `onerror`, no timeout. When the CDN request
  **hung or failed** (flaky network), `onload` never fired → the window never printed and never
  closed = the freeze. The item "goes away" because `openPrint` records the cut + writes tags
  BEFORE opening the print window (locked flow, unchanged). Affected all print paths (bin/cut/
  swatch) since they all open this page.
- **Fix (client approved — locked print flow, so confirmed scope first): bundle JsBarcode
  locally.** Added `jsbarcode` as a dep **pinned to 3.11.6** (the exact CDN version), `import`ed
  it, and draw barcodes directly — **no external fetch**, so the CDN-hang freeze can't happen.
  Wrapped the draw in try/catch + kept the 250ms print timer OUTSIDE it, so a bad barcode value
  now still prints/closes instead of freezing. **Labels are byte-identical** — same version,
  same CODE128 options (heights 11/10, width 1.4, margin 0, displayValue false), same label
  HTML/CSS/info/assembly, same cut→tag→print sequence. ONLY the library *source* changed (CDN →
  bundle) + the never-freeze safety. Print bundle 6→68 kB (expected: JsBarcode now included).
  Build clean. **Verified by user: printed twice, works as expected.**
- **Follow-on bug found + fixed: stuck modal backdrop after returning from the print window.**
  On a final cut the "Order Complete" modal `showOverlay()`s and then `window.open` steals
  focus in the same tick, so App Bridge left the backdrop **half-open (scrim painted, no box)
  and stuck** — cleared only by another modal cycle. Same risk for a non-final cut's
  auto-advance opening the next line's note modal as the print window opens. The three
  imperatively-opened modals (completion/note/moveToCutList) only re-sync when their *state*
  changes, so nothing fixed it on return. **Fix (additive, ~40 lines):** a NEW focus/
  visibilitychange listener that re-asserts each of those overlays to its current state on
  return (state set → showOverlay repaints; null → hideOverlay clears the scrim). Uses mirror
  refs (`completionMessageRef`/`noteModalContentRef`/`moveToCutListConfirmRef`). SEPARATE from
  the locked `primeTokenAndRevalidate` onVisible handler — does not touch auto-refresh rules;
  idempotent; can't re-pop an acknowledged modal (null state → only hideOverlay). Build clean.
  **Pending user test.**

### 2026-07-30 (part 2 — "200" screen / recurring 401s → library upgrade)
- **Client reported a bare white "200" screen** (black "200" text) + more 401s. Partial URL
  showed it was on **`/auth/session-token?...`** — the App Bridge embedded **session-token
  bounce page**. So the "200" and the 401s are the SAME root: the embedded re-auth handshake
  failing/stranding, NOT app logic (grepped every route — nothing emits a bare "200"/"401").
- **Ruled OUT the database** (I initially suspected it — corrected course):
  - The app has its **own** Supabase DB (ref `nqncfqpgalttqhndeucr`); the Supabase MCP in my
    session is connected to a DIFFERENT project (`bvvmmhekdgskeilczeuy` "afG Tracking Methods",
    a heavy analytics DB) — do NOT analyze that one for app auth issues. Saved as memory
    [[eos-supabase-databases]].
  - Prod `DATABASE_URL` confirmed on the app's own DB, port **5432** (session-mode pooler).
  - Pulled 24h of the app DB's OWN logs (user CSV export): **nearly idle** — routine
    checkpoints (2–12 buffers), NO `too many clients`/connection-slot errors, NO statement
    timeouts. So connection exhaustion is NOT happening. The 5432→6543 transaction-pooler
    tweak is optional hardening, **not** the cause — deprioritized.
- **Fix (evidence-based): upgraded `@shopify/shopify-app-react-router` 1.1.0 → 1.2.1.**
  The 1.2.1 changelog fixes EXACTLY this: *"embedded apps would incorrectly show the login
  page when `shop` or `host` query params were missing from a document request"* → now shows
  a minimal App Bridge page that fetches the session token from the parent frame for seamless
  re-auth. (Also a security fix: `authenticate.admin().redirect()` no longer leaks embedded
  params cross-origin.) Webhook handlers verified compatible (they only use stable
  `shop`/`session`/`topic`/`payload` fields; 1.2.0's webhook-type change only ADDED fields).
  Build clean; only package.json/lock changed. **Pending: user tests embedded auth in dev,
  then deploys; real confirmation = a few days of live cutting with no 200/401 (timing
  doesn't repro in a dev tunnel).**
- **Note — typecheck was already broken pre-upgrade** (unrelated): `shopify-web-components.d.ts`
  is a JSON config misnamed `.d.ts`, so `tsc --noEmit` errors on it. Not ours, not the upgrade.
  Use `npm run build` (clean) as the gate, per existing convention.
- **Open follow-ups (deferred, independent of the upgrade):** (1) `authPathPrefix: "/auth"`
  (shopify.server.ts) vs `shopify.app.toml` `redirect_urls = [".../api/auth"]` mismatch —
  no `/api/auth` route exists; reconcile as its own scoped change. (2) optional 5432→6543
  transaction pooler + `DIRECT_URL`.

### 2026-07-30
- **NEW: in-app "Command-F" list search** (client request — cutters can't use the browser's
  Cmd-F because it also finds text outside the app window). Added an **always-visible search
  bar** in the sticky header (client chose always-visible, no keyboard shortcut). Type a
  string → matches in the current list are highlighted, a `n / N` match count shows, and
  **↑ Prev / ↓ Next** (or Enter / Shift-Enter in the field, Esc to clear) step through
  matches, scrolling each into view.
  - **Implementation is a pure ADDITIVE overlay — touches no locked function.** Highlighting
    uses the **CSS Custom Highlight API** (`CSS.highlights` + `Range` + `::highlight()`),
    which does **NOT mutate the DOM** — so the 30s auto-refresh re-render can't clobber it and
    it can't fight the cut/tag/print flow, sort, or filters. Scope is the `<s-table>` subtree
    only (`searchContainerRef`), i.e. list rows, not the summary cards. A **MutationObserver**
    on the table re-runs the search after each list re-render (refresh / filter change /
    optimistic update) so counts + highlights stay live; re-applying highlights doesn't mutate
    DOM so it can't loop the observer. Works on **every** filter/list automatically since it
    reads whatever the table currently renders.
  - Search state: `searchQuery`, `searchMatchCount`, `searchCurrentMatch` (+ `*Ref` mirrors
    for the observer/callbacks); helpers `recomputeSearch` / `applySearchHighlights` /
    `stepSearchMatch` / `scrollToCurrentMatch`. Highlight names `cutlist-search` (all,
    #ffe08a) + `cutlist-search-current` (active, #ff9d00, `priority=1`). Injected `<style>`
    for the two pseudo-elements.
  - **Scroll-to-match (`scrollToCurrentMatch`) — non-obvious, got it wrong twice first:**
    Polaris `<s-text>`/`<s-table-cell>`/`<s-table-row>` are all `display: contents` (no
    layout box), so `element.scrollIntoView()` is a no-op OR resolves to a giant ancestor
    (whole `<s-table>`) and jumps to the table's middle. FIX: read the **Range's own**
    `getBoundingClientRect()` (true rendered position of the matched text), find the real
    scroll container (nearest `overflowY: auto/scroll` ancestor with overflow; else the
    window), and **only scroll if the match is not already fully visible** — then nudge the
    *minimum* to bring it into view (no re-centering; real-Cmd-F feel). The window path uses
    the sticky-header bottom (`stickyHeaderRef`) as the top boundary so a match can't hide
    under the sticky summary cards. Re-centering every step (my first working version) yanked
    already-visible matches off-screen — don't do that.
  - **VERIFIED by user** in the demo store (highlights render over Polaris rows; count +
    Prev/Next + scroll all correct). Browser note: CSS Custom Highlight API needs Chrome/Edge
    105+ / Safari 17.2+ (warehouse runs Chrome — fine); it paints over light-DOM text slotted
    into the Polaris `<s-*>` shadow DOM. Text rendered via an attribute (not a light-DOM text
    node) won't highlight — acceptable (customer/order#/title/SKU/bin/tags are all text
    children). Fallback if ever needed: React `<mark>`-wrap of row text (more invasive).
  - Builds clean (`npm run build`). **Uncommitted — user will push.**

### 2026-07-21
- **Added the top-of-file REGRESSION GUARD protocol** (client request): before any edit,
  flag if it might unintentionally change/remove a locked function; don't touch adjacent
  behavior silently. Also saved as a `feedback` memory. Client has been burned by updates
  quietly dropping features — treat this as standing policy.
- **Fixed: final-cut auto-advance vs "Order Complete" ordering.** On the last cut of an
  order, the app both showed "Order Complete" AND immediately auto-advanced to the next
  line — whose note popped BEFORE/under the completion message (confusing). Now on a final
  cut (`pickedCount === totalCount`) the advance is **deferred**: stored in `pendingAdvance`
  and applied in `acknowledgeCompletion()` when the cutter dismisses the modal (wired to
  the completion modal's onHide + OK). Non-final cuts advance immediately as before; the
  same-SKU pre-print (`markReadyToPrint`) is preserved. Applied to BOTH `openPrint` and
  `printSwatchBundle`. Builds clean; pending user test in demo store.
- **NEW: SKU position-lock + within-group auto-advance** (client — the batch-jumping fix).
  Landed in two steps.
  - *Step 1 — within-group auto-advance (option B):* after a cut, keep cutting the SAME
    fabric — next uncut item of that SKU after the current one, wrapping to the top of the
    group — until the whole group is cut, then the next line. In `openPrint`. Verified.
  - *Step 2 — position-lock (replaces the old time-anchor `skuAnchorTimes`):* the ACTIVE
    SKU group is pinned in place; `listLock = {sku, order[]}` (localStorage). `effectiveCreatedAt`
    now returns own time; `naturalAllItems` memo + a capture effect (re-snapshots when the
    active SKU changes) + `applyListLock`. Lock follows activation; new same-SKU orders
    append to the group tail; persists across reload.
- **REGRESSION I caused + fixed same session (rush-to-top).** Step 2's first cut froze the
  WHOLE list, so a new rush order landed at the BOTTOM instead of the top — breaking the
  locked rush-to-top behavior. Root failure: I flagged the deviation as a post-build
  "caveat" instead of STOPPING before, per the guard. Fix: after `applyListLock`, re-float
  rush (rush orders + items sharing a rush order's SKU) to the top. Rush-to-top added to
  the top-of-file locked-functions list. **Rule: anything layered over the sort MUST
  re-float rush to the top.**
- **Fixed: Rush Orders card counted line items, not orders** (`rushOrders.length` → unique
  orderIds). Latent bug (committed), surfaced by the first 2-line rush order; my changes
  didn't cause it. `rushOrders` memo stays line-item-level for the rush filter/sort.
- **Inventory warning → badge-only** (client): removed the modal pop-up. Activation auto-pop
  is note-only again; the `⚠️ CHECK INVENTORY` badge is now a passive indicator (no click
  modal). Left the modal's inventory section as inert dead code (didn't touch the note modal
  — locked). Then **excluded swatches + roll ends** from the badge (in `hasInventoryWarning`).
  Verified.
- Commit `dea9c55` (local): position-lock + within-group advance + completion sequencing +
  rush fixes + regression guard. The inventory-badge tweaks above are on top, being
  committed/pushed by the user next.
- Open thread: still verifying the position-lock across edge cases (rush interplay,
  reload, mid-list groups) in the demo store.

### 2026-07-16
- **Fixed: the 2026-07-09 auth work froze the auto-refresh in production** (client saw the
  white 401 again + a stale list; "Last updated" counter climbing forever). Root causes —
  all regressions I introduced on 2026-07-09 — found via console logging after 3 wrong
  guesses:
  1. `if (document.hidden) return` in the 30s interval — `document.hidden` reads **true**
     in the embedded iframe even while on-screen → every tick bailed. **Removed.**
  2. `isTyping` inferred from `document.activeElement`/`contenteditable` — the scan field
     is a Polaris `<s-text-field>`, always focused, reporting `contenteditable=true`, so it
     looked like perpetual typing → every tick bailed with "typing". **Now** keys off actual
     barcode TEXT (`barcodeInputs`), so an empty focused field doesn't block.
  3. `await window.shopify.idToken()` unconditionally — can HANG on a stale session and
     never reach `revalidate()`. **Now** raced against a 2s timeout.
  Net: the 30s poll works on-screen again (counter ticks 1→30→1), pauses only during a real
  scan, and can't be frozen. Verified by user (idle resets; typing pauses; 225s+ idle→return
  clean).
- **401 white-page — conservative fix.** Removed the custom catch-401-and-
  `window.location.reload()` ErrorBoundary; it reloaded the iframe with STALE embedded params
  and could itself produce the bare 401. `ErrorBoundary` now just `boundary.error(...)` —
  Shopify's built-in App Bridge re-auth. Note: some bare 401s are document-level (React not
  mounted) and can't be caught in-app; a one-time reload remains the fallback. See the new
  **401 handling** bullet in Core concepts.
- **NOTE re-pops on EVERY activation** (client): removed the `acknowledgedNotes` once-per-
  order gate; keyed to a real `activeLineId` change (not the 30s refresh). Verified.
- **NEW: inventory warning modal** (client — replacing a Shopify Flow they'll remove).
  Per-line `⚠️ CHECK INVENTORY` alert on activation (+ badge) when `inventoryQuantity <= 0`
  (available stock, already net of commitments — do NOT subtract line qty, that double-
  counts; validated against a real 0/21 order the Flow had flagged). Shares the activation
  modal with the note (side-by-side sections when both). See the **Activation alert** bullet
  in Core concepts. Verified.
- **NEW: `graphqlWithRetry`** wraps loader GraphQL (3 tries, 300/600ms backoff) so a Shopify
  **503 "Service Unavailable"** blip self-heals instead of white-screening. Client hit a 503
  twice in the demo store — confirmed it's a transient Shopify-side issue, not our code.
- Open thread: **per-cutter Cut History attribution** needs online tokens — deferred, see
  Known quirks.
- **Roll ends now use the SAME scan→print flow as normal by-the-yard products** (client
  request). Previously a scanned roll end only offered "Print Bin Label" / "Mark Already
  Printed" (bin only, no product label); it was missing a way to print the product label.
  - Fix: removed the `isRollEnd(item)` branch in the `readyToPrint` action cell
    (~app._index.tsx:3387) so roll ends fall through to the normal
    **Print Labels → Print Product Label** button (`openPrint(item, !alreadyPrinted)`).
  - Safe because swatches are handled by the `isBundleRow` branch *above* `readyToPrint`,
    so they're untouched; and `isRollEnd()` is still used for the Roll Ends Only
    count/filter. Net rule now: **swatch → bundle flow; every other product → shared normal
    flow.** See the new print-flow bullet in Core concepts (and the corrected roll-end note
    — `isRollEnd()` is counts/filters only now, no longer the print button).
  - Verified by user in the test store; builds clean.
- Supabase Postgres upgrade (from 2026-07-09 thread) is **done**: project on **17.6.1.141**
  (above the 121 threshold). Management API lagged on the version field for a while but the
  dashboard confirmed it. App-side 401 fix also pushed. That thread is closed.

### 2026-07-09
- **Fixed: intermittent bare white "401 Unauthorized" page** (client report — cutter
  occasionally gets it, reload fixes it, disrupts cutting).
  - Diagnosis: 401 = failed auth on the app's own **loader** request (not a tag write —
    we never throw "401 Unauthorized"; it's the library). Two contributing causes:
    1. **Expired embedded session token.** Shopify session tokens live ~60s; the app
       revalidated instantly on focus/visibility + every 30s, so after a station sat idle
       (tab backgrounded / asleep) a background request could fire on an expired token →
       loader `authenticate.admin` rejects → white 401. Reload re-runs token exchange.
    2. **Supabase capacity incident (Jul 6–8).** `DATABASE_URL` is on Supabase
       (`pooler.supabase`), and sessions live in that Postgres (`PrismaSessionStorage`).
       During the incident, session reads/token-exchange writes could fail intermittently
       → same 401. Project `bvvmmhekdgskeilczeuy` is on Postgres **17.6.1.063**, which is
       BELOW the `17.6.1.121` threshold Supabase flagged as most affected (older = narrower
       instance types). **Open thread: upgrade Postgres to 17.6.1.121+** off-hours (brief
       restart/downtime) from the dashboard infra settings — no code/env change.
  - App-side fix (`app._index.tsx`), verified by user in the test store:
    - New `primeTokenAndRevalidate()` — `await window.shopify.idToken()` (forces a fresh
      token) BEFORE every 30s / focus / visibility revalidation. Verified: 225s+ idle →
      return refreshes cleanly, no 401.
    - Skip the 30s tick while `document.hidden` (backgrounded); resumes on return.
    - Self-healing `ErrorBoundary` (bottom of file): auto-reload ONCE on a 401
      (`cutlist-401-reload` sessionStorage guard vs loop), else defer to `boundary.error`.
      Low-risk safety net for any residual/DB-blip 401; not directly reproducible in dev.
    - Made the **"Last updated" counter reset on every completed revalidation** (was only
      on data change), after the client asked "if the cutter stays on screen, is it still
      updating?" — it always WAS polling; the counter just looked frozen when quiet. Now it
      ticks 1→30→1 on a visible screen as live proof. Verified by user.
    - Removed the `[refresh]` debug logs.
  - See the updated **Auto-refresh** bullet in Core concepts for the durable behavior.
- Builds clean. **Uncommitted — user will push.** After push, real confirmation is a day
  of live cutter use (embedded-auth timing doesn't fully reproduce in a dev tunnel).

### 2026-07-02
- **Reference links now open in a new tab** (client request — cutters were losing their
  place: links took over the app frame, then they had to reload and re-find their spot).
  - Cause: links were `shopify://admin/...` App Bridge deep links, which navigate the
    *parent* Shopify admin (steals the embedded app's frame).
  - Fix: new `adminUrl(resource, id)` helper builds `https://admin.shopify.com/store/
    <handle>/...` from `data.shop` (added `session.shop` to the loader return); all 5 links
    (customer, order, 3× product/SKU) switched to it with `target="_blank"`. See the new
    "Reference links open in a NEW TAB" bullet in Core concepts. Verified by user: customer/
    order/product/SKU all open a fresh tab, cut-list tab stays put; note + picture modals
    unaffected.
  - Also cleaned up the dead `pageInfo` (loader return + unused state) left by the 2026-07-01
    pagination change (`queryOrders` no longer returns pageInfo).
- Pagination fix from 2026-07-01 verified in prod: pre/post counts identical (12/12), list
  loads fully. Real proof (no cost error at ~7pm peak) is the ongoing watch.
- Builds clean. **Uncommitted — user will push.**
- Open thread: `MAX_PAGES = 60` in `queryOrders` caps each query at ~3000 orders (safety
  net vs runaway cursor). Fine at current scale (~51); bump to ~200 if volume ever grows.

### 2026-07-01
- **Fixed: loader hitting Shopify's single-query cost limit** (client saw *"Query cost is
  1487, which exceeds the single query max cost limit (1000)"* ~7pm ET; fine by morning).
  - Cause: `queryOrders` fetched `orders(first: 250)` with `lineItems(first: 50)` + nested
    variant/image/2 metafields/fulfillmentOrders in ONE query. Cost scales with matched
    orders, so it crossed 1000 when volume was high. The intermittent evening-only pattern
    fits the **picked-today** query (`tag:picked … -fulfillment_status:fulfilled`): cut
    orders are never fulfilled by the app, so that set **accumulates through the day** and
    **drains overnight** when EasyScan fulfills → cost high at 7pm, low by morning.
  - Fix: **cursor pagination in `queryOrders`** — loops `first: 50` pages via `after`/
    `endCursor` until `hasNextPage` is false, stitches into one `edges[]`. Each page is a
    small fixed-cost query, so the single-query ceiling can't be hit regardless of volume.
    Return shape unchanged (`{ edges }`), callers untouched. `MAX_PAGES = 60` safety stop.
    Also removes the old silent **250-order cap**. Server-side only — the cutter still sees
    one continuous list (NOT UI paging). Builds clean.
  - Note: this fixes the *single-query cost* limit permanently. The separate *rate-limit*
    bucket (points/sec across all requests) is a far higher ceiling that degrades
    gracefully (throttle+retry); only relevant at ~50–100× current scale, where Shopify
    **bulk operations** would be the tool. Not needed now.

### 2026-06-29
- **Full audit + fix of every summary filter-card count**, card by card against client
  intent. New durable reference: the *Filter-card count conventions* bullet in Core
  concepts — read that before touching any card count. Highlights of what changed:
  - *Total Orders to Pick* → unique orders with ≥1 uncut line (`uniqueOrders` now derived
    from `uncutItems`; was over-counting fully-cut lingering orders).
  - *Total Cuts to Pick* → line items not unit quantity; **swatches bundle per order**
    (`nonSwatchCuts + swatchBundleOrders.size`) to match the list's single bundle row.
    Caught live: card showed 19 vs 17 visible rows because of swatch bundling.
  - *Total Swatches to Pick* → swatch **bundles** (`swatchBundleOrders.size`), reused from
    Total Cuts. Caught live: 11 line items vs 9 bundles.
  - *Roll Ends Only* + *Swatches Only* → strict **original-composition** rule via new
    generic `getFullOrderOnlyIds(predicate)` (a mixed order reduced to one type by cutting
    must NOT qualify — cutters handle single-type orders differently "from order submit").
  - New `isRollEnd()` helper: roll end = variant/fabric length contains **"yard piece"**.
    The old `productType === "roll end"` signal is **deprecated** (client confirmed via
    Shopify screenshot — roll ends now have productType "fabric by yard"). **Also fixed a
    real bug**: the roll-end **print button** used the dead productType check, so roll ends
    weren't getting their special print flow. Now uses `isRollEnd()`.
  - *Multiple Orders* → renamed **"Customers with Multiple Orders"**, count = unique
    customers (was line items over raw `cutListItems`). Removed the dead duplicate
    `multiple` filter branch.
  - *Local Pickup* + *Fulfillment Hold* → unique orders, sourced to match their lists.
  - *Items/Orders Cut Log*, *Ready to Ship* → verified already-correct, left as-is
    (Ready to Ship keeps the per-line `ready-to-ship` OR clause — single items are
    promoted manually on purpose).
- **Bug fixed (regression I introduced, then caught via live test + the diagnose route):
  fully-cut order put ON HOLD vanished from everywhere.** Root cause chain: a fully-cut
  order is tagged `picked` → excluded from the main query (`-tag:picked`); Ready to Ship
  excludes holds (`!hasHold`); and my first Hold-card rewrite sourced only
  `cutListItemsVisible` (derived from the main query) → the order had nowhere to appear.
  Fix: restored the `holdItems` memo spanning **cutListItems + pickedTodayItems**, so held
  orders show in any cut state. Key lesson now in Core concepts: **a held order must NOT
  drop off when fully cut** (it can't ship) — Hold is NOT "the same as Local Pickup" in
  that respect, even though the count is still unique-orders. `app.diagnose?order=N` was
  the decisive tool (showed main query returned 0 for the held order).
- Verified live by user: held orders (cut and uncut) show correctly; move-to-cut-list
  bumps Total Cuts by exactly +1 (the line-item change makes it +1 not +quantity);
  move-to-ready-to-ship adds the order to Ready to Ship.
- All changes build clean (`npm run build`). **Uncommitted — user will push.**
- Open threads:
  - **`read_all_orders` scope** not yet added (Rush shows 5 vs 6 because the 6th is
    >90 days old, past the 60-day `read_orders` window). User will do the scope request
    later. See Known quirks.
  - Hydration-mismatch + leftover `[refresh]`/`[silk]` debug logs still untouched.

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

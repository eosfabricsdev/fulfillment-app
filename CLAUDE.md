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
  - `picked-line:<numericLineId>_<sku>` — a specific line item was cut
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
  rebuild understanding of the app.
- **Created this CLAUDE.md** documenting architecture, the tag-based state model, the
  optimistic-UI/protected-window mechanism, routes, and dev commands.
- Established the **session-end protocol** (top of this file): update this log + docs
  before ending each session.
- No code changes made this session.
- Open threads: leftover `[refresh]`/`[silk]` debug `console.log`s could be cleaned up;
  duplicate `multiple` branch in `getFilteredItems()`.

// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

// "Bin & Barcode" tool — scan/type barcodes or SKUs into a RUNNING LIST, then
// Replace or Add the same Bin Number on all of them at once (EasyScan-style batch
// bin assignment; used e.g. to consolidate many roll ends into one bin). Bins live
// in the variant metafield custom.bin_number as a single pipe-separated string
// (e.g. "A2|NA"), NOT a list type. Writing variant metafields is covered by the
// app's existing `write_products` scope — no new scope.
const BIN_NAMESPACE = "custom";
const BIN_KEY = "bin_number";
const SET_CHUNK = 25; // metafieldsSet accepts up to 25 metafields per call

function splitBins(value: string): string[] {
  return (value || "")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "lookup") {
    const raw = String(formData.get("query") || "").trim();
    if (!raw) return { intent, found: false, error: "Enter a SKU or barcode." };
    const safe = raw.replace(/["\\]/g, "\\$&");
    const resp = await admin.graphql(
      `#graphql
      query LookupVariant($query: String!) {
        productVariants(first: 5, query: $query) {
          edges {
            node {
              id
              title
              sku
              barcode
              image { url }
              product { title featuredImage { url } }
              metafield(namespace: "${BIN_NAMESPACE}", key: "${BIN_KEY}") {
                value
                type
              }
            }
          }
        }
      }`,
      { variables: { query: `sku:${safe} OR barcode:${safe}` } },
    );
    const json = await resp.json();
    const edges = json?.data?.productVariants?.edges ?? [];
    if (edges.length === 0) return { intent, found: false, query: raw };
    const n = edges[0].node;
    return {
      intent,
      found: true,
      query: raw,
      variant: {
        id: n.id,
        title: n.title,
        sku: n.sku,
        barcode: n.barcode,
        productTitle: n.product?.title ?? "",
        imageUrl: n.image?.url ?? n.product?.featuredImage?.url ?? null,
        currentBin: n.metafield?.value ?? "",
        metafieldType: n.metafield?.type ?? "single_line_text_field",
      },
    };
  }

  if (intent === "updateBatch") {
    const mode = String(formData.get("mode") || ""); // "replace" | "add"
    const value = String(formData.get("value") || "").trim();
    let ids: string[] = [];
    try {
      ids = JSON.parse(String(formData.get("variantIds") || "[]"));
    } catch {
      ids = [];
    }
    if (!ids.length || !value || (mode !== "replace" && mode !== "add")) {
      return { intent, ok: false, error: "Missing or invalid data." };
    }

    // Read every item's current bin in one shot (authoritative read-modify-write).
    const readResp = await admin.graphql(
      `#graphql
      query BinsForNodes($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            metafield(namespace: "${BIN_NAMESPACE}", key: "${BIN_KEY}") {
              value
              type
            }
          }
        }
      }`,
      { variables: { ids } },
    );
    const readJson = await readResp.json();
    const nodes = readJson?.data?.nodes ?? [];
    const curById = new Map<string, { value: string; type: string }>();
    for (const n of nodes) {
      if (n?.id) {
        curById.set(n.id, {
          value: n.metafield?.value ?? "",
          type: n.metafield?.type ?? "single_line_text_field",
        });
      }
    }

    // Compute per-item new values; collect the ones that actually need a write.
    const results: any[] = [];
    const toWrite: any[] = [];
    for (const id of ids) {
      const cur = curById.get(id);
      if (!cur) {
        results.push({ id, status: "error", error: "Not found" });
        continue;
      }
      if (mode === "replace") {
        toWrite.push({
          ownerId: id,
          namespace: BIN_NAMESPACE,
          key: BIN_KEY,
          type: cur.type,
          value,
        });
        results.push({ id, status: "updated", newValue: value });
      } else {
        const parts = splitBins(cur.value);
        if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) {
          results.push({ id, status: "duplicate", newValue: cur.value });
        } else {
          const nv = [...parts, value].join("|");
          toWrite.push({
            ownerId: id,
            namespace: BIN_NAMESPACE,
            key: BIN_KEY,
            type: cur.type,
            value: nv,
          });
          results.push({ id, status: "updated", newValue: nv });
        }
      }
    }

    // Write in chunks of 25. metafieldsSet writes the valid ones and returns
    // userErrors (with the offending index) for any that fail — map those back.
    for (let i = 0; i < toWrite.length; i += SET_CHUNK) {
      const chunk = toWrite.slice(i, i + SET_CHUNK);
      const setResp = await admin.graphql(
        `#graphql
        mutation SetBins($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        { variables: { metafields: chunk } },
      );
      const setJson = await setResp.json();
      const errs = setJson?.data?.metafieldsSet?.userErrors ?? [];
      for (const e of errs) {
        const idx = Array.isArray(e.field) ? parseInt(e.field[1], 10) : NaN;
        const owner = !isNaN(idx) && chunk[idx] ? chunk[idx].ownerId : null;
        const r = owner ? results.find((x) => x.id === owner) : null;
        if (r) {
          r.status = "error";
          r.error = e.message;
        }
      }
    }

    const summary = {
      updated: results.filter((r) => r.status === "updated").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      error: results.filter((r) => r.status === "error").length,
    };
    return { intent, ok: true, mode, value, results, summary };
  }

  return { intent, ok: false, error: "Unknown action." };
};

export default function BinBarcodePage() {
  const lookupFetcher = useFetcher();
  const updateFetcher = useFetcher();

  const [query, setQuery] = useState("");
  const [scanQueue, setScanQueue] = useState<string[]>([]); // pending scans to look up
  const [items, setItems] = useState<any[]>([]); // running list of variants
  const [newBin, setNewBin] = useState("");
  const [confirm, setConfirm] = useState<any>(null); // { mode, value, count }
  const [notice, setNotice] = useState<any>(null); // { tone, text }

  const scanRef = useRef<any>(null);
  const confirmModalRef = useRef<any>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const debounceRef = useRef<any>(null); // input-settle timer (auto-add)
  const lastInputRef = useRef<number>(0); // timestamp of last keystroke

  const busy = lookupFetcher.state !== "idle" || scanQueue.length > 0;
  const updating = updateFetcher.state !== "idle";

  useEffect(() => {
    const t = setTimeout(() => scanRef.current?.focus?.(), 50);
    return () => clearTimeout(t);
  }, []);

  // Serialize lookups: only one in flight at a time. A single fetcher cancels an
  // in-flight submit when a new one fires, so rapid scanning would otherwise drop
  // items. When the fetcher is idle and scans are queued, look up the next one.
  useEffect(() => {
    if (lookupFetcher.state === "idle" && scanQueue.length > 0) {
      const next = scanQueue[0];
      setScanQueue((q) => q.slice(1));
      lookupFetcher.submit({ intent: "lookup", query: next }, { method: "post" });
    }
  }, [lookupFetcher.state, scanQueue]);

  // A scan resolved → add to the running list (dedupe by variant id).
  useEffect(() => {
    const d = lookupFetcher.data;
    if (!d || d.intent !== "lookup") return;
    if (d.found) {
      const v = d.variant;
      if (itemsRef.current.some((it) => it.id === v.id)) {
        setNotice({ tone: "info", text: `Already in the list: ${v.sku || v.productTitle}.` });
      } else {
        setItems((prev) => [...prev, { ...v, result: null }]);
        setNotice(null);
      }
    } else {
      setNotice({ tone: "warning", text: `No product found for "${d.query}".` });
    }
  }, [lookupFetcher.data]);

  // Batch update finished → fold per-item results back into the list + summarize.
  useEffect(() => {
    const d = updateFetcher.data;
    if (!d || d.intent !== "updateBatch") return;
    if (!d.ok) {
      setNotice({ tone: "critical", text: d.error || "Update failed." });
      return;
    }
    const byId = new Map(d.results.map((r: any) => [r.id, r]));
    setItems((prev) =>
      prev.map((it) => {
        const r: any = byId.get(it.id);
        if (!r) return it;
        return {
          ...it,
          result: r.status,
          currentBin: r.status === "error" ? it.currentBin : r.newValue ?? it.currentBin,
        };
      }),
    );
    setNewBin("");
    const parts = [
      `${d.summary.updated} updated`,
      d.summary.duplicate ? `${d.summary.duplicate} already had it` : null,
      d.summary.error ? `${d.summary.error} failed` : null,
    ].filter(Boolean);
    setNotice({
      tone: d.summary.error ? "warning" : "success",
      text: `${d.mode === "replace" ? "Replaced" : "Added"} "${d.value}": ${parts.join(", ")}.`,
    });
    setTimeout(() => scanRef.current?.focus?.(), 50);
  }, [updateFetcher.data]);

  // Drive the confirm modal overlay from state.
  useEffect(() => {
    const el = confirmModalRef.current;
    if (!el) return;
    try {
      if (confirm) el.showOverlay?.();
      else el.hideOverlay?.();
    } catch {
      // ignore
    }
  }, [confirm]);

  // Add a value to the queue and clear the field — no Enter, no button. The queue
  // effect above looks each one up in order.
  const enqueueScan = (raw: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const q = (raw ?? "").trim();
    if (!q) return;
    setScanQueue((prev) => [...prev, q]);
    setQuery("");
    setTimeout(() => scanRef.current?.focus?.(), 0);
  };

  // Auto-add when input stops arriving — no key/click needed. A barcode scanner
  // types the whole value in a rapid burst then stops, so we settle quickly after
  // fast input; a person typing a SKU is slower, so we wait longer before firing
  // (and keep resetting while they type) to avoid firing mid-SKU.
  const onScanInput = (value: string) => {
    setQuery(value);
    const now = Date.now();
    const gap = now - lastInputRef.current;
    lastInputRef.current = now;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) return;
    const delay = gap < 40 ? 110 : 650; // burst (scanner) vs. manual typing
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      enqueueScan(value);
    }, delay);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const clearAll = () => {
    setItems([]);
    setNotice(null);
    setTimeout(() => scanRef.current?.focus?.(), 30);
  };

  const startApply = (mode: "replace" | "add") => {
    const value = newBin.trim();
    if (!items.length) {
      setNotice({ tone: "warning", text: "Scan at least one item first." });
      return;
    }
    if (!value) {
      setNotice({ tone: "warning", text: "Enter a Bin Number first." });
      return;
    }
    setConfirm({ mode, value, count: items.length });
  };

  const confirmApply = () => {
    if (!confirm) return;
    updateFetcher.submit(
      {
        intent: "updateBatch",
        mode: confirm.mode,
        value: confirm.value,
        variantIds: JSON.stringify(items.map((it) => it.id)),
      },
      { method: "post" },
    );
    setConfirm(null);
  };

  const resultBadge = (r: string | null) => {
    if (r === "updated") return <s-badge tone="success">Updated</s-badge>;
    if (r === "duplicate") return <s-badge tone="warning">Already had it</s-badge>;
    if (r === "error") return <s-badge tone="critical">Failed</s-badge>;
    return null;
  };

  return (
    <s-page heading="Bin & Barcode" inlineSize="large">
      <s-section heading="Scan items">
        <s-stack gap="base">
          <s-text color="subdued">
            Scan a barcode or type a SKU — each valid item is added to the list
            automatically (no button or Enter needed). Add as many as you like,
            then assign one Bin Number to all of them at once.
          </s-text>
          <s-stack direction="inline" gap="base" alignItems="center">
            <div style={{ minWidth: "340px" }}>
              <s-text-field
                ref={scanRef}
                label="Barcode or SKU"
                placeholder="Scan barcode or type SKU…"
                value={query}
                onInput={(e: any) => onScanInput(e.currentTarget.value)}
                onKeyDown={(e: any) => {
                  // Optional accelerator: if a scanner sends an Enter suffix, add
                  // instantly instead of waiting for the input-settle timer.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    enqueueScan(e.currentTarget.value);
                  }
                }}
              />
            </div>
            {busy && <s-text color="subdued">Adding…</s-text>}
          </s-stack>
          {notice && (
            <s-banner tone={notice.tone}>
              <s-text>{notice.text}</s-text>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Items (${items.length})`}>
        {items.length === 0 ? (
          <s-text color="subdued">No items yet — scan or type a barcode/SKU above.</s-text>
        ) : (
          <s-stack gap="base">
            <s-stack gap="small">
              {items.map((it) => (
                <s-box
                  key={it.id}
                  padding="small-200"
                  background="subdued"
                  borderWidth="base"
                  borderColor="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    {it.imageUrl ? (
                      <img
                        src={it.imageUrl}
                        alt={it.productTitle}
                        style={{
                          width: "48px",
                          height: "48px",
                          objectFit: "cover",
                          borderRadius: "6px",
                          display: "block",
                        }}
                      />
                    ) : (
                      <s-thumbnail alt="No image" size="small-200" />
                    )}
                    <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <s-stack gap="small-500">
                        <s-text type="strong">{it.productTitle}</s-text>
                        <s-text color="subdued">
                          {it.sku ? `SKU: ${it.sku}` : ""}
                          {it.barcode ? ` | ${it.barcode}` : ""}
                        </s-text>
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-text color="subdued">Bin:</s-text>
                          {it.currentBin ? (
                            <s-badge tone="info">{it.currentBin}</s-badge>
                          ) : (
                            <s-badge>None</s-badge>
                          )}
                          {resultBadge(it.result)}
                        </s-stack>
                      </s-stack>
                    </div>
                    <s-button
                      variant="tertiary"
                      disabled={updating}
                      onClick={() => removeItem(it.id)}
                    >
                      Remove
                    </s-button>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-button variant="tertiary" disabled={updating} onClick={clearAll}>
                Clear list
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {items.length > 0 && (
        <s-section heading="Assign Bin Number">
          <s-stack gap="base">
            <div style={{ maxWidth: "320px" }}>
              <s-text-field
                label="Bin Number"
                placeholder="e.g. B5"
                value={newBin}
                onInput={(e: any) => setNewBin(e.currentTarget.value)}
              />
            </div>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                disabled={updating || !newBin.trim()}
                onClick={() => startApply("replace")}
              >
                Replace on all ({items.length})
              </s-button>
              <s-button
                variant="secondary"
                disabled={updating || !newBin.trim()}
                onClick={() => startApply("add")}
              >
                Add to all ({items.length})
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-modal
        id="bin-batch-confirm"
        heading="Confirm bin assignment"
        ref={confirmModalRef}
        onHide={() => setConfirm(null)}
      >
        <s-box padding="base">
          {confirm && (
            <s-stack gap="small">
              <s-text>
                {confirm.mode === "replace" ? "Replace" : "Add"} bin{" "}
                <s-badge tone="info">{confirm.value}</s-badge>{" "}
                {confirm.mode === "replace" ? "on" : "to"} all{" "}
                <s-text type="strong">{confirm.count}</s-text> item
                {confirm.count === 1 ? "" : "s"}?
              </s-text>
              <s-text color="subdued">
                {confirm.mode === "replace"
                  ? "This overwrites each item's current bin(s)."
                  : "Items that already have this bin are skipped."}
              </s-text>
            </s-stack>
          )}
        </s-box>
        <s-button slot="primary-action" variant="primary" onClick={confirmApply}>
          Confirm
        </s-button>
        <s-button slot="secondary-actions" onClick={() => setConfirm(null)}>
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

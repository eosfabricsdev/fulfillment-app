// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

// "Bin & Barcode" tool — scan/enter a SKU or barcode, then Replace or Add the
// variant's Bin Number metafield (custom.bin_number). Writing variant metafields
// is covered by the app's existing `write_products` scope (no new scope). Bins are
// stored as a single pipe-separated string in one single_line_text_field (e.g.
// "A2|NA"), matching the existing convention seen in the admin.
const BIN_NAMESPACE = "custom";
const BIN_KEY = "bin_number";

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
    if (!raw) {
      return { intent, found: false, error: "Enter a SKU or barcode." };
    }
    // Escape quotes/backslashes so the value can't break the search query.
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
    if (edges.length === 0) {
      return { intent, found: false, query: raw };
    }
    const n = edges[0].node;
    return {
      intent,
      found: true,
      query: raw,
      multiple: edges.length > 1,
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

  if (intent === "update") {
    const variantId = String(formData.get("variantId") || "");
    const mode = String(formData.get("mode") || ""); // "replace" | "add"
    const value = String(formData.get("value") || "").trim();
    if (!variantId || !value || (mode !== "replace" && mode !== "add")) {
      return { intent, ok: false, error: "Missing or invalid data." };
    }

    // Re-read the current bin at write time (safe read-modify-write + authoritative
    // duplicate check), rather than trusting a value the client fetched earlier.
    const cur = await admin.graphql(
      `#graphql
      query CurrentBin($id: ID!) {
        node(id: $id) {
          ... on ProductVariant {
            metafield(namespace: "${BIN_NAMESPACE}", key: "${BIN_KEY}") {
              value
              type
            }
          }
        }
      }`,
      { variables: { id: variantId } },
    );
    const curJson = await cur.json();
    const mf = curJson?.data?.node?.metafield;
    const currentBin = mf?.value ?? "";
    const type = mf?.type ?? "single_line_text_field";

    let newValue = value;
    if (mode === "add") {
      const parts = splitBins(currentBin);
      const dup = parts.some((p) => p.toLowerCase() === value.toLowerCase());
      if (dup) {
        return { intent, ok: false, duplicate: true, currentBin, value };
      }
      newValue = [...parts, value].join("|");
    }

    const setResp = await admin.graphql(
      `#graphql
      mutation SetBin($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: variantId,
              namespace: BIN_NAMESPACE,
              key: BIN_KEY,
              type,
              value: newValue,
            },
          ],
        },
      },
    );
    const setJson = await setResp.json();
    const errs = setJson?.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length > 0) {
      return { intent, ok: false, error: errs.map((e) => e.message).join("; ") };
    }
    return { intent, ok: true, mode, previousBin: currentBin, newValue };
  }

  return { intent, ok: false, error: "Unknown action." };
};

export default function BinBarcodePage() {
  const lookupFetcher = useFetcher();
  const updateFetcher = useFetcher();

  const [query, setQuery] = useState("");
  const [variant, setVariant] = useState<any>(null);
  const [newBin, setNewBin] = useState("");
  const [confirm, setConfirm] = useState<any>(null); // { mode, currentBin, preview } | { duplicate, value }
  const [notice, setNotice] = useState<any>(null); // { tone, text }

  const scanRef = useRef<any>(null);
  const confirmModalRef = useRef<any>(null);

  const looking = lookupFetcher.state !== "idle";
  const updating = updateFetcher.state !== "idle";

  // Focus the scan field on mount.
  useEffect(() => {
    const t = setTimeout(() => scanRef.current?.focus?.(), 50);
    return () => clearTimeout(t);
  }, []);

  // Handle lookup results.
  useEffect(() => {
    const d = lookupFetcher.data;
    if (!d || d.intent !== "lookup") return;
    if (d.found) {
      setVariant(d.variant);
      setNewBin("");
      setNotice(
        d.multiple
          ? { tone: "warning", text: "Multiple variants matched — showing the first." }
          : null,
      );
    } else {
      setVariant(null);
      setNotice({
        tone: "warning",
        text: `No product found for "${d.query ?? query}".`,
      });
    }
  }, [lookupFetcher.data]);

  // Handle update results.
  useEffect(() => {
    const d = updateFetcher.data;
    if (!d || d.intent !== "update") return;
    if (d.ok) {
      setVariant((v: any) => (v ? { ...v, currentBin: d.newValue } : v));
      setNewBin("");
      setNotice({
        tone: "success",
        text: `Bin Number updated${
          d.previousBin ? ` (was "${d.previousBin}")` : ""
        } → "${d.newValue}".`,
      });
      setTimeout(() => scanRef.current?.focus?.(), 50);
    } else if (d.duplicate) {
      setNotice({
        tone: "warning",
        text: `Bin Number "${d.value}" is already on this product.`,
      });
    } else {
      setNotice({ tone: "critical", text: d.error || "Update failed." });
    }
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

  const doLookup = () => {
    const q = query.trim();
    if (!q) return;
    setNotice(null);
    lookupFetcher.submit({ intent: "lookup", query: q }, { method: "post" });
  };

  const startUpdate = (mode: "replace" | "add") => {
    if (!variant) return;
    const value = newBin.trim();
    if (!value) {
      setNotice({ tone: "warning", text: "Enter a Bin Number first." });
      return;
    }
    const currentBin = variant.currentBin || "";
    if (mode === "add") {
      const parts = splitBins(currentBin);
      if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) {
        setConfirm({ duplicate: true, value });
        return;
      }
      setConfirm({ mode, currentBin, preview: [...parts, value].join("|"), value });
    } else {
      setConfirm({ mode, currentBin, preview: value, value });
    }
  };

  const confirmUpdate = () => {
    if (!variant || !confirm || confirm.duplicate) {
      setConfirm(null);
      return;
    }
    updateFetcher.submit(
      {
        intent: "update",
        variantId: variant.id,
        mode: confirm.mode,
        value: confirm.value,
      },
      { method: "post" },
    );
    setConfirm(null);
  };

  return (
    <s-page heading="Bin & Barcode" inlineSize="large">
      <s-section heading="Update Bin Number">
        <s-stack gap="base">
          <s-text color="subdued">
            Scan or type a barcode or SKU, then Replace or Add the product's Bin
            Number.
          </s-text>
          <s-stack direction="inline" gap="base" alignItems="end">
            <div style={{ minWidth: "320px" }}>
              <s-text-field
                ref={scanRef}
                label="Barcode or SKU"
                placeholder="Scan barcode or type SKU…"
                value={query}
                onInput={(e: any) => setQuery(e.currentTarget.value)}
                onKeyDown={(e: any) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    doLookup();
                  }
                }}
              />
            </div>
            <s-button variant="primary" disabled={looking || !query.trim()} onClick={doLookup}>
              {looking ? "Looking up…" : "Look up"}
            </s-button>
          </s-stack>

          {notice && (
            <s-banner tone={notice.tone}>
              <s-text>{notice.text}</s-text>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {variant && (
        <s-section heading="Product">
          <s-box
            padding="base"
            background="subdued"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="inline" gap="base" alignItems="start">
              {variant.imageUrl && (
                <s-image
                  src={variant.imageUrl}
                  alt={variant.productTitle}
                  style={{
                    width: "72px",
                    height: "72px",
                    objectFit: "cover",
                    borderRadius: "8px",
                  }}
                />
              )}
              <s-stack gap="small">
                <s-text type="strong">{variant.productTitle}</s-text>
                {variant.title && variant.title !== "Default Title" && (
                  <s-text color="subdued">{variant.title}</s-text>
                )}
                <s-text color="subdued">
                  SKU: {variant.sku || "—"}
                  {variant.barcode ? ` | Barcode: ${variant.barcode}` : ""}
                </s-text>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text color="subdued">Current Bin:</s-text>
                  {variant.currentBin ? (
                    <s-badge tone="info">{variant.currentBin}</s-badge>
                  ) : (
                    <s-badge>None</s-badge>
                  )}
                </s-stack>
              </s-stack>
            </s-stack>
          </s-box>

          <s-stack gap="base">
            <div style={{ maxWidth: "320px" }}>
              <s-text-field
                label="Bin Number"
                placeholder="e.g. A2"
                value={newBin}
                onInput={(e: any) => setNewBin(e.currentTarget.value)}
              />
            </div>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                disabled={updating || !newBin.trim()}
                onClick={() => startUpdate("replace")}
              >
                Replace Bin
              </s-button>
              <s-button
                variant="secondary"
                disabled={updating || !newBin.trim()}
                onClick={() => startUpdate("add")}
              >
                Add Bin
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {/* Preview + confirm (or duplicate notice). */}
      <s-modal
        id="bin-confirm-modal"
        heading={confirm?.duplicate ? "Already on product" : "Confirm Bin Number change"}
        ref={confirmModalRef}
        onHide={() => setConfirm(null)}
      >
        <s-box padding="base">
          {confirm?.duplicate ? (
            <s-text>
              Bin Number "{confirm.value}" is already on this product. Nothing to
              add.
            </s-text>
          ) : (
            <s-stack gap="small">
              <s-text>
                {confirm?.mode === "replace" ? "Replace" : "Add"} on{" "}
                <s-text type="strong">{variant?.productTitle}</s-text>:
              </s-text>
              <s-text>
                <s-badge>{confirm?.currentBin || "None"}</s-badge> →{" "}
                <s-badge tone="info">{confirm?.preview}</s-badge>
              </s-text>
            </s-stack>
          )}
        </s-box>
        {!confirm?.duplicate && (
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={confirmUpdate}
          >
            Confirm
          </s-button>
        )}
        <s-button slot="secondary-actions" onClick={() => setConfirm(null)}>
          {confirm?.duplicate ? "OK" : "Cancel"}
        </s-button>
      </s-modal>
    </s-page>
  );
}

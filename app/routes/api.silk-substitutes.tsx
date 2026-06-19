// @ts-nocheck
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Resource route (no UI component) so the client can POST directly with `fetch`
// and read JSON back. React Router 7 uses single fetch: posting to a route that
// renders UI (e.g. `/app`) is matched to the layout route and 405s, so the silk
// resolver lives here on its own endpoint instead.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const itemsJson = String(formData.get("items") || "[]");
  let inputs: Array<{ productId: string; colorCode: string }> = [];
  try {
    inputs = JSON.parse(itemsJson);
  } catch {
    inputs = [];
  }

  const variantFields = `
    sku
    barcode
    title
    selectedOptions { name value }
    product { id title }
    colorCode: metafield(namespace: "custom", key: "color_code") { value }
  `;

  const cdcResp = await admin.graphql(
    `#graphql
    query CdcAnchor {
      productVariants(first: 1, query: "sku:41031") {
        nodes {
          product {
            id
            title
            variants(first: 250) {
              nodes {
                ${variantFields}
              }
            }
          }
        }
      }
    }`,
  );
  const cdcJson = await cdcResp.json();
  const cdcProduct = cdcJson.data?.productVariants?.nodes?.[0]?.product ?? null;
  const cdcVariants: any[] = cdcProduct?.variants?.nodes ?? [];

  const uniqueProductIds = Array.from(
    new Set(inputs.map((i) => i.productId).filter(Boolean)),
  );
  const productVariantsMap = new Map<string, any[]>();
  for (const pid of uniqueProductIds) {
    const resp = await admin.graphql(
      `#graphql
      query OrderedProduct($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 250) {
            nodes {
              ${variantFields}
            }
          }
        }
      }`,
      { variables: { id: pid } },
    );
    const json = await resp.json();
    productVariantsMap.set(pid, json.data?.product?.variants?.nodes ?? []);
  }

  const norm = (s: string | null | undefined) =>
    (s ?? "").trim().toLowerCase();
  const findSwatch = (variants: any[], colorCode: string) => {
    const target = norm(colorCode);
    return (
      variants.find((v) => {
        const flOpt = v.selectedOptions?.find(
          (o: any) => norm(o.name) === "fabric length",
        );
        const fl = norm(flOpt?.value);
        const vc = norm(v.colorCode?.value);
        return fl === "swatch sample" && vc === target;
      }) ?? null
    );
  };

  const toPayload = (v: any) =>
    v
      ? {
          productTitle: v.product?.title ?? "",
          variantTitle: v.title ?? null,
          sku: v.sku ?? "",
          barcode: v.barcode ?? null,
          colorCode: v.colorCode?.value ?? null,
        }
      : null;

  const results = inputs.map(({ productId, colorCode }) => {
    const subA = findSwatch(cdcVariants, colorCode);
    const orderedVariants = productVariantsMap.get(productId) ?? [];
    const subB = findSwatch(orderedVariants, "101");
    return {
      productId,
      colorCode,
      substituteA: toPayload(subA),
      substituteB: toPayload(subB),
    };
  });

  // TEMP DIAGNOSTIC — remove after debugging substituteA (CDC-in-ordered-color).
  // Shows what the CDC anchor lookup actually returned so we can see whether the
  // CDC swatch variants carry color_code values matching the ordered colors.
  const cdcSwatchColorCodes = cdcVariants
    .filter(
      (v) =>
        norm(
          v.selectedOptions?.find((o: any) => norm(o.name) === "fabric length")
            ?.value,
        ) === "swatch sample",
    )
    .map((v) => v.colorCode?.value ?? null);

  return Response.json({
    ok: true,
    results,
    debug: {
      cdcProductTitle: cdcProduct?.title ?? null,
      cdcVariantCount: cdcVariants.length,
      cdcSwatchCount: cdcSwatchColorCodes.length,
      cdcColorCodes: cdcSwatchColorCodes,
      requestedColors: inputs.map((i) => i.colorCode),
    },
  });
};

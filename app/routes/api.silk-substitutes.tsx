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

  // SKU 41031 is shared across the CDC "By the Yard" AND "Swatch Sample" products.
  // Fetch ALL variants with that SKU (not just the first product's) so findSwatch
  // can pick the Swatch Sample variant in the ordered color, regardless of which
  // product it lives in.
  const cdcResp = await admin.graphql(
    `#graphql
    query CdcAnchor {
      productVariants(first: 250, query: "sku:41031") {
        nodes {
          ${variantFields}
        }
      }
    }`,
  );
  const cdcJson = await cdcResp.json();
  const cdcVariants: any[] = cdcJson.data?.productVariants?.nodes ?? [];

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

  // Raw sample of the first few CDC variants so we can see the actual option
  // names/values and the color_code metafield as Shopify returns them.
  const cdcSample = cdcVariants.slice(0, 5).map((v) => ({
    title: v.title,
    sku: v.sku,
    selectedOptions: v.selectedOptions,
    colorCode: v.colorCode?.value ?? null,
  }));

  return Response.json({
    ok: true,
    results,
    debug: {
      cdcProductTitles: Array.from(
        new Set(cdcVariants.map((v) => v.product?.title).filter(Boolean)),
      ),
      cdcVariantCount: cdcVariants.length,
      cdcSwatchCount: cdcSwatchColorCodes.length,
      cdcColorCodes: cdcSwatchColorCodes,
      requestedColors: inputs.map((i) => i.colorCode),
      cdcSample,
    },
  });
};

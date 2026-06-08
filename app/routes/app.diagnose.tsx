// @ts-nocheck
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const orderName = url.searchParams.get("order") || "";

  const cleanName = orderName.replace(/^#/, "");

  const queries = orderName
    ? [
        {
          label: "raw name lookup (no filters)",
          query: `name:${cleanName}`,
        },
        {
          label: "name with hash",
          query: `name:#${cleanName}`,
        },
        {
          label: "broad token search",
          query: cleanName,
        },
        {
          label: "main cut list query",
          query: `name:${cleanName} (fulfillment_status:unfulfilled OR fulfillment_status:on_hold OR fulfillment_status:partial) -status:cancelled -tag:picked -tag:'picked by EasyScan'`,
        },
      ]
    : [];

  queries.push({
    label: "5 most recent orders in this shop (no filter)",
    query: "",
  });

  const results = [];

  const directId = url.searchParams.get("id");
  let directNode: any = null;
  if (directId) {
    const gid = directId.startsWith("gid://")
      ? directId
      : `gid://shopify/Order/${directId}`;
    const resp = await admin.graphql(
      `#graphql
      query DiagNode($id: ID!) {
        node(id: $id) {
          ... on Order {
            id
            name
            tags
            displayFulfillmentStatus
            displayFinancialStatus
            cancelledAt
            createdAt
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  currentQuantity
                  unfulfilledQuantity
                  fulfillmentStatus
                  sku
                }
              }
            }
          }
        }
      }`,
      { variables: { id: gid } },
    );
    const json = await resp.json();
    directNode = json.data?.node ?? null;
    results.push({
      label: `direct ID lookup (${gid})`,
      query: gid,
      orders: directNode ? [directNode] : [],
      errors: json.errors ?? null,
    });
  }

  for (const q of queries) {
    const resp = await admin.graphql(
      `#graphql
      query DiagOrders($query: String!) {
        orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              tags
              displayFulfillmentStatus
              displayFinancialStatus
              cancelledAt
              createdAt
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    currentQuantity
                    unfulfilledQuantity
                    fulfillmentStatus
                    sku
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { query: q.query } },
    );
    const json = await resp.json();
    results.push({
      label: q.label,
      query: q.query,
      orders: json.data?.orders?.edges?.map((e: any) => e.node) ?? [],
      errors: json.errors ?? null,
    });
  }

  return { orderName: cleanName, shop: session.shop, results, error: null };
};

export default function DiagnosePage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading={`Diagnose order #${data.orderName || "?"}`} inlineSize="large">
      <s-section>
        <s-text type="strong">Authenticated shop: {data.shop}</s-text>
      </s-section>

      {data.error && (
        <s-section>
          <s-text>{data.error}</s-text>
        </s-section>
      )}

      {data.results?.map((r: any, idx: number) => (
        <s-section key={idx} heading={r.label}>
          <s-stack gap="base">
            <s-text type="strong">Query: {r.query}</s-text>
            <s-text>Returned orders: {r.orders.length}</s-text>

            {r.errors && (
              <s-text tone="critical">
                Errors: {JSON.stringify(r.errors)}
              </s-text>
            )}

            {r.orders.map((o: any) => {
              const lineItems = o.lineItems.edges.map((e: any) => e.node);
              return (
                <s-box
                  key={o.id}
                  padding="base"
                  background="subdued"
                  borderWidth="base"
                  borderColor="base"
                  borderRadius="base"
                >
                  <s-stack gap="small">
                    <s-text type="strong">{o.name}</s-text>
                    <s-text>
                      displayFulfillmentStatus: {o.displayFulfillmentStatus}
                    </s-text>
                    <s-text>
                      displayFinancialStatus: {o.displayFinancialStatus}
                    </s-text>
                    <s-text>cancelledAt: {o.cancelledAt ?? "null"}</s-text>
                    <s-text>tags: {JSON.stringify(o.tags)}</s-text>
                    <s-text type="strong">
                      Line items ({lineItems.length}):
                    </s-text>
                    {lineItems.map((li: any) => {
                      const skipReasons: string[] = [];
                      if (li.unfulfilledQuantity === 0)
                        skipReasons.push("unfulfilledQuantity===0");
                      if (li.fulfillmentStatus?.toLowerCase() === "fulfilled")
                        skipReasons.push("fulfillmentStatus===fulfilled");
                      if (li.currentQuantity === 0)
                        skipReasons.push("currentQuantity===0");
                      return (
                        <s-box
                          key={li.id}
                          padding="small"
                          background="base"
                          borderWidth="base"
                          borderColor="base"
                          borderRadius="base"
                        >
                          <s-stack gap="small">
                            <s-text>{li.title}</s-text>
                            <s-text color="subdued">SKU: {li.sku}</s-text>
                            <s-text>
                              qty={li.quantity}, currentQuantity=
                              {li.currentQuantity}, unfulfilledQuantity=
                              {li.unfulfilledQuantity}
                            </s-text>
                            <s-text>
                              fulfillmentStatus: {li.fulfillmentStatus ?? "null"}
                            </s-text>
                            {skipReasons.length > 0 ? (
                              <s-text tone="critical">
                                WOULD BE SKIPPED: {skipReasons.join(", ")}
                              </s-text>
                            ) : (
                              <s-text tone="success">passes line filter</s-text>
                            )}
                          </s-stack>
                        </s-box>
                      );
                    })}
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

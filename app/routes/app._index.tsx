// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";

const VIRTUAL_SKU = "85496775805861";

type Metafield = {
  key: string;
  value: string;
  namespace: string;
};

type Variant = {
  id: string;
  barcode: string | null;
  inventoryQuantity: number;
  metafields: {
    edges: Array<{
      node: Metafield;
    }>;
  };
} | null;

type Product = {
  id: string;
  featuredImage: {
    url: string;
    altText: string | null;
  } | null;
};

type LineItem = {
  id: string | null;
  title: string;
  quantity: number;
  currentQuantity: number;
  fulfillmentStatus: string | null;
  sku: string | null;
  vendor: string | null;
  variantTitle: string | null;
  product: Product | null;
  variant: Variant | null;
};

type Customer = {
  id: string;
  displayName: string;
} | null;

type FulfillmentOrder = {
  id: string;
  fulfillmentHolds: Array<{
    reason: string;
  }>;
};

type RawOrder = {
  id: string;
  name: string;
  createdAt: string;
  note: string | null;
  tags: string[];
  customer: Customer;
  fulfillmentOrders: {
    nodes: FulfillmentOrder[];
  };
  lineItems: {
    edges: Array<{
      node: LineItem;
    }>;
  };
};

type CutListItem = {
  orderId: string;
  orderName: string;
  orderCreatedAt: string;
  orderNote: string | null;
  orderTags: string[];
  customerId: string | null;
  customerName: string;
  lineItemId: string;
  productId: string;
  productTitle: string;
  sku: string;
  variantTitle: string | null;
  quantity: number;
  variantId: string;
  barcode: string | null;
  binNumber: string;
  hasHold: boolean;
  allLineItems: LineItem[];
  productImage: string | null;
  productImageAlt: string | null;
};

function isPickedByTag(orderTags: string[]): boolean {
  return orderTags.some((tag) => {
    const normalized = tag.trim().toLowerCase();
    return normalized.includes("picked by");
  });
}

function toCutListItems(
  orders: RawOrder[],
  options?: {
    includePicked?: boolean;
  },
): CutListItem[] {
  const includePicked = options?.includePicked ?? false;
  const items: CutListItem[] = [];

  for (const order of orders) {
    const hasHold = order.fulfillmentOrders.nodes.some(
      (fo) => fo.fulfillmentHolds.length > 0,
    );
    const allLineItems = order.lineItems.edges.map((e) => e.node);

    for (const edge of order.lineItems.edges) {
      const lineItem = edge.node;
      if (!includePicked) {
        if (lineItem.fulfillmentStatus === "FULFILLED") continue;
        if (lineItem.currentQuantity === 0) continue;
        if (isPickedByTag(order.tags ?? [])) continue;
      }

      if (lineItem.sku === VIRTUAL_SKU) continue;

      const binNumber =
        lineItem.variant?.metafields?.edges.find(
          (e) => e.node.key === "bin_number",
        )?.node.value || "";

        if (!lineItem.title) continue;
        if (!lineItem.id) continue;

      items.push({
        orderId: order.id,
        orderName: order.name,
        orderCreatedAt: order.createdAt,
        orderNote: order.note,
        orderTags: order.tags ?? [],
        customerId: order.customer?.id || null,
        customerName: order.customer?.displayName || "Guest",
        lineItemId: lineItem.id || `${order.id}-${lineItem.title}`,
        productId: lineItem.product?.id || "",
        productTitle: lineItem.title,
        sku: lineItem.sku || "",
        variantTitle: lineItem.variantTitle,
        quantity: lineItem.currentQuantity,
        variantId: lineItem.variant?.id || "",
        barcode: lineItem.variant?.barcode || null,
        binNumber,
        hasHold,
        allLineItems,
        productImage: lineItem.product?.featuredImage?.url || null,
        productImageAlt: lineItem.product?.featuredImage?.altText || null,
      });
    }
  }

  return items;
}

async function queryOrders(admin: any, query: string) {
  const response = await admin.graphql(
    `#graphql
    query GetOrders($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            name
            tags
            createdAt
            note
            customer {
              id
              displayName
            }
            fulfillmentOrders(first: 3) {
              nodes {
                id
                fulfillmentHolds {
                  reason
                }
              }
            }
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  currentQuantity
                  fulfillmentStatus
                  sku
                  vendor
                  variantTitle
                  product {
                    id
                    featuredImage {
                      url
                      altText
                    }
                  }
                  variant {
                    id
                    barcode
                    inventoryQuantity
                    metafields(first: 20) {
                      edges {
                        node {
                          key
                          value
                          namespace
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }`,
    {
      variables: {
        first: 250,
        query,
      },
    },
  );

  const json = await response.json();
  return json.data?.orders || { edges: [], pageInfo: null };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const mainOrdersResult = await queryOrders(
    admin,
    `status:open -status:cancelled`,
  );

  const pickedTodayResult = await queryOrders(
    admin,
    `tag:picked OR tag:'partially picked'`,
  );

  const rawOrders: RawOrder[] = mainOrdersResult.edges.map((e: any) => e.node);
  const pickedOrders: RawOrder[] = pickedTodayResult.edges.map(
    (e: any) => e.node,
  );

  const cutListItems = toCutListItems(rawOrders, { includePicked: false });
  const pickedTodayItems = toCutListItems(pickedOrders, { includePicked: true });

  return {
    cutListItems,
    pickedTodayItems,
    pageInfo: mainOrdersResult.pageInfo,
    employeeName: "Unknown",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const orderId = String(formData.get("orderId") || "");
  const tags = formData.getAll("tags").map(String);

  if (!intent || !orderId) {
    return { ok: false };
  }

  if (intent === "tagsAdd") {
    await admin.graphql(
      `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`,
      {
        variables: { id: orderId, tags },
      },
    );
    return { ok: true };
  }

  if (intent === "tagsRemove") {
    await admin.graphql(
      `#graphql
      mutation TagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`,
      {
        variables: { id: orderId, tags },
      },
    );
    return { ok: true };
  }

  return { ok: false };
};

export default function CutListPage() {
  const data = useLoaderData<typeof loader>();
  const tagFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [cutListItems, setCutListItems] = useState<CutListItem[]>(
    data.cutListItems || [],
  );
  useEffect(() => {
    setCutListItems(data.cutListItems || []);
    setPickedTodayItems(data.pickedTodayItems || []);
    setLastUpdated(new Date());
  }, [data.cutListItems, data.pickedTodayItems]);

  const [pageInfo] = useState<any>(data.pageInfo || null);
  const [loading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set());
  const [printedLines, setPrintedLines] = useState<Set<string>>(new Set());
  const [readyToPrint, setReadyToPrint] = useState<Set<string>>(new Set());
  const [employeeName] = useState<string>(data.employeeName || "Unknown");
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0);
  const [currentFilter, setCurrentFilter] = useState<
    "all" | "rush" | "rollEnds" | "swatches" | "pickedToday" | "multiple"
  >("all");
  const [pickedTodayItems, setPickedTodayItems] = useState<CutListItem[]>(
    data.pickedTodayItems || [],
  );
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [showProductCountModal, setShowProductCountModal] =
    useState<boolean>(false);
  const [productCountModalItems, setProductCountModalItems] = useState<
    LineItem[]
  >([]);
  const [productCountModalOrderName, setProductCountModalOrderName] =
    useState<string>("");
  const [previewImage, setPreviewImage] = useState<{
    url: string;
    alt: string;
  } | null>(null);
  const [barcodeInputs, setBarcodeInputs] = useState<Record<string, string>>({});
  const [barcodeErrors, setBarcodeErrors] = useState<Record<string, string>>({});

  const rushOrders = useMemo(
    () => cutListItems.filter((item) => isRushOrder(item.orderTags)),
    [cutListItems],
  );

  useEffect(() => {
    if (tagFetcher.state === "idle" && tagFetcher.data?.ok) {
      // no-op; optimistic UI is already updating local state
    }
  }, [tagFetcher.state, tagFetcher.data]);

  useEffect(() => {
    if (getFilteredItems().length > 0 && !activeLineId) {
      setActiveLineId(getFilteredItems()[0].lineItemId);
    }
  }, [cutListItems, currentFilter, activeLineId]);

  useEffect(() => {
    const timestampInterval = setInterval(() => {
      const now = new Date();
      const diff = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
      setSecondsSinceUpdate(diff);
    }, 1000);

    return () => clearInterval(timestampInterval);
  }, [lastUpdated]);

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTyping =
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.getAttribute("contenteditable") === "true";
  
      if (isTyping) return;
      if (revalidator.state !== "idle") return;
      if (showProductCountModal || !!previewImage) return;
  
      revalidator.revalidate();
    }, 30000);
  
    return () => clearInterval(refreshInterval);
  }, [revalidator, showProductCountModal, previewImage]);

  useEffect(() => {
    setLastUpdated(new Date());
  }, [data.cutListItems, data.pickedTodayItems]);

  function submitTagsAdd(orderId: string, tags: string[]) {
    const form = new FormData();
    form.append("intent", "tagsAdd");
    form.append("orderId", orderId);
    tags.forEach((tag) => form.append("tags", tag));
    tagFetcher.submit(form, { method: "post" });
  }

  function submitTagsRemove(orderId: string, tags: string[]) {
    const form = new FormData();
    form.append("intent", "tagsRemove");
    form.append("orderId", orderId);
    tags.forEach((tag) => form.append("tags", tag));
    tagFetcher.submit(form, { method: "post" });
  }

  const applyCustomerBatchingSort = (items: CutListItem[]): CutListItem[] => {
    const customerGroups = new Map<string, CutListItem[]>();

    for (const item of items) {
      const key = item.customerId || "guest";
      if (!customerGroups.has(key)) {
        customerGroups.set(key, []);
      }
      customerGroups.get(key)!.push(item);
    }

    const customerGroupsWithLatest = Array.from(customerGroups.entries()).map(
      ([customerId, items]) => {
        const latestTime = Math.max(
          ...items.map((i) => new Date(i.orderCreatedAt).getTime()),
        );
        return { customerId, items, latestTime };
      },
    );

    customerGroupsWithLatest.sort((a, b) => a.latestTime - b.latestTime);

    const sortedItems: CutListItem[] = [];
    for (const group of customerGroupsWithLatest) {
      group.items.sort(
        (a, b) =>
          new Date(a.orderCreatedAt).getTime() -
          new Date(b.orderCreatedAt).getTime(),
      );
      sortedItems.push(...group.items);
    }

    const skuGroups = new Map<string, CutListItem[]>();
    for (const item of sortedItems) {
      if (!skuGroups.has(item.sku)) {
        skuGroups.set(item.sku, []);
      }
      skuGroups.get(item.sku)!.push(item);
    }

    const finalItems: CutListItem[] = [];
    const processedSkus = new Set<string>();

    for (const item of sortedItems) {
      if (processedSkus.has(item.sku)) continue;

      const skuGroup = skuGroups.get(item.sku)!;
      skuGroup.sort(
        (a, b) =>
          new Date(a.orderCreatedAt).getTime() -
          new Date(b.orderCreatedAt).getTime(),
      );
      finalItems.push(...skuGroup);
      processedSkus.add(item.sku);
    }

    return finalItems;
  };

  const applyCustomerOnlySort = (items: CutListItem[]): CutListItem[] => {
    const customerGroups = new Map<string, CutListItem[]>();
  
    for (const item of items) {
      const key = item.customerId || "guest";
      if (!customerGroups.has(key)) {
        customerGroups.set(key, []);
      }
      customerGroups.get(key)!.push(item);
    }
  
    const customerGroupsWithLatest = Array.from(customerGroups.entries()).map(
      ([customerId, items]) => {
        const latestTime = Math.max(
          ...items.map((i) => new Date(i.orderCreatedAt).getTime()),
        );
        return { customerId, items, latestTime };
      },
    );
  
    customerGroupsWithLatest.sort((a, b) => a.latestTime - b.latestTime);
  
    const sortedItems: CutListItem[] = [];
    for (const group of customerGroupsWithLatest) {
      group.items.sort(
        (a, b) =>
          new Date(a.orderCreatedAt).getTime() -
          new Date(b.orderCreatedAt).getTime(),
      );
      sortedItems.push(...group.items);
    }
  
    return sortedItems;
  };

  const applyRushFirstSort = (items: CutListItem[]): CutListItem[] => {
    const rushOrderIds = new Set(
      items.filter((item) => isRushOrder(item.orderTags)).map((o) => o.orderId),
    );
    const rushItems = items.filter((item) => rushOrderIds.has(item.orderId));
    const nonRushItems = items.filter((item) => !rushOrderIds.has(item.orderId));

    rushItems.sort(
      (a, b) =>
        new Date(a.orderCreatedAt).getTime() -
        new Date(b.orderCreatedAt).getTime(),
    );

    const sortedNonRush = applyCustomerBatchingSort(nonRushItems);
    return [...rushItems, ...sortedNonRush];
  };

  const processRushItems = (items: CutListItem[]): CutListItem[] => {
    return [...items].sort(
      (a, b) =>
        new Date(a.orderCreatedAt).getTime() -
        new Date(b.orderCreatedAt).getTime(),
    );
  };

  const getVariantTypeBadge = (variantTitle: string | null) => {
    if (!variantTitle) return null;

    if (variantTitle.includes("By the Yard")) {
      return <s-badge tone="info">By the Yard</s-badge>;
    } else if (variantTitle.includes("Swatch Sample")) {
      return <s-badge tone="warning">Swatch Sample</s-badge>;
    } else if (variantTitle.includes("Panel")) {
      return <s-badge tone="caution">Panel</s-badge>;
    } else if (variantTitle.includes("Yard Piece")) {
      return <s-badge tone="success">{variantTitle}</s-badge>;
    }
    return null;
  };

  const formatQuantity = (quantity: number, variantTitle: string | null) => {
    if (variantTitle?.includes("By the Yard")) {
      return (
        <s-stack gap="small">
          <s-text>{quantity} units</s-text>
          <s-text type="strong">{(quantity / 4).toFixed(2)} yds</s-text>
        </s-stack>
      );
    }
    return <s-text>{quantity} units</s-text>;
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  function isRushOrder(orderTags: string[]): boolean {
    return orderTags.some((tag) => tag.toLowerCase() === "rush");
  }


  const getPickedByName = (orderTags: string[]): string => {
    const excludeTags = ["picked", "partially picked", "printed", "rush"];
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}/;

    for (const tag of orderTags) {
      if (!excludeTags.includes(tag.toLowerCase()) && !isoDatePattern.test(tag)) {
        return tag;
      }
    }
    return employeeName;
  };

  const getFilteredItems = (): CutListItem[] => {
    if (currentFilter === "pickedToday") {
      return pickedTodayItems;
    }

    if (currentFilter === "rush") {
      return processRushItems(rushOrders);
    }

    if (currentFilter === "multiple") {
      const multipleItems = cutListItems.filter((item) =>
        item.orderTags.some((t) => t.toLowerCase() === "multiple orders"),
      );
    
      return applyCustomerOnlySort(multipleItems);
    }

    const allItems = applyRushFirstSort(cutListItems);

    if (currentFilter === "rollEnds") {
      const rollEndOrders = new Set<string>();
      const orderMap = new Map<string, CutListItem[]>();

      allItems.forEach((item) => {
        if (!orderMap.has(item.orderId)) {
          orderMap.set(item.orderId, []);
        }
        orderMap.get(item.orderId)!.push(item);
      });

      orderMap.forEach((items, orderId) => {
        const allAreYardPiece = items.every((item) =>
          item.variantTitle?.includes("Yard Piece"),
        );
        if (allAreYardPiece) {
          rollEndOrders.add(orderId);
        }
      });

      return allItems.filter((item) => rollEndOrders.has(item.orderId));
    }

    if (currentFilter === "swatches") {
      const swatchOrders = new Set<string>();
      const orderMap = new Map<string, CutListItem[]>();

      allItems.forEach((item) => {
        if (!orderMap.has(item.orderId)) {
          orderMap.set(item.orderId, []);
        }
        orderMap.get(item.orderId)!.push(item);
      });

      orderMap.forEach((items, orderId) => {
        const allAreSwatches = items.every((item) =>
          item.variantTitle?.includes("Swatch Sample"),
        );
        if (allAreSwatches) {
          swatchOrders.add(orderId);
        }
      });

      return allItems.filter((item) => swatchOrders.has(item.orderId));
    }

    if (currentFilter === "multiple") {
      return allItems.filter((item) =>
        item.orderTags.some(
          (t) => t.toLowerCase() === "multiple orders"
        )
      );
    }

    return allItems;
  };

  const getSummaryStats = () => {
    const filteredCutListItems = cutListItems.filter(
      (item) => item.sku !== VIRTUAL_SKU,
    );
    const uniqueOrders = new Set(filteredCutListItems.map((i) => i.orderId));
    const totalCuts = filteredCutListItems.length;

    const orderMap = new Map<string, CutListItem[]>();
    filteredCutListItems.forEach((item) => {
      if (!orderMap.has(item.orderId)) {
        orderMap.set(item.orderId, []);
      }
      orderMap.get(item.orderId)!.push(item);
    });

    let rollEndsOnlyCount = 0;
    let swatchesOnlyCount = 0;

    orderMap.forEach((items) => {
      const allAreYardPiece = items.every((item) =>
        item.variantTitle?.includes("Yard Piece"),
      );
      const allAreSwatches = items.every((item) =>
        item.variantTitle?.includes("Swatch Sample"),
      );

      if (allAreYardPiece) rollEndsOnlyCount++;
      if (allAreSwatches) swatchesOnlyCount++;
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split("T")[0];

    const filteredPickedTodayItems = pickedTodayItems.filter(
      (item) => item.sku !== VIRTUAL_SKU,
    );
    const uniqueOrdersToday = new Set<string>();
    let itemsCountToday = 0;

    filteredPickedTodayItems.forEach((item) => {
      const hasTimestampToday = item.orderTags.some((tag) => {
        try {
          const date = new Date(tag);
          if (!isNaN(date.getTime())) {
            const tagDateStr = date.toISOString().split("T")[0];
            return tagDateStr === todayStr;
          }
        } catch (err) {
          return false;
        }
        return false;
      });

      if (hasTimestampToday) {
        uniqueOrdersToday.add(item.orderId);
        itemsCountToday++;
      }
    });

    return {
      rushOrders: rushOrders.length,
      ordersCutToday: uniqueOrdersToday.size,
      itemsCutToday: itemsCountToday,
      totalOrders: uniqueOrders.size,
      totalCuts,
      rollEndsOnly: rollEndsOnlyCount,
      swatchesOnly: swatchesOnlyCount,
    };
  };

  const handleProductCountClick = (item: CutListItem) => {
    setProductCountModalItems(item.allLineItems);
    setProductCountModalOrderName(item.orderName);
    setShowProductCountModal(true);
  };

  const handleBarcodeScan = async (
    itemKey: string,
    value: string,
    item: CutListItem,
  ) => {
    setBarcodeInputs((prev) => ({ ...prev, [itemKey]: value }));
    setBarcodeErrors((prev) => {
      const next = { ...prev };
      delete next[itemKey];
      return next;
    });

    if (!value) return;

    if (!item.barcode) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: "NO_BARCODE" }));
      return;
    }

    if (value !== item.barcode) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: "MISMATCH" }));
      return;
    }

    setReadyToPrint((prev) => new Set(prev).add(item.lineItemId));
    setPickedItems((prev) => new Set(prev).add(item.lineItemId));
    setBarcodeInputs((prev) => ({ ...prev, [itemKey]: "" }));

    const orderItems = cutListItems.filter((i) => i.orderId === item.orderId);
    const pickedCount = orderItems.filter(
      (i) => pickedItems.has(i.lineItemId) || i.lineItemId === item.lineItemId,
    ).length;
    const totalCount = orderItems.filter((i) => i.sku !== VIRTUAL_SKU).length;
    const timestamp = new Date().toISOString();

    if (pickedCount === 1) {
      submitTagsAdd(item.orderId, ["partially picked", timestamp]);
      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, "partially picked", timestamp])),
              }
            : i,
        ),
      );
    } else if (pickedCount === totalCount) {
      submitTagsRemove(item.orderId, ["partially picked"]);
      submitTagsAdd(item.orderId, ["picked", timestamp]);

      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(
                  new Set([
                    ...i.orderTags.filter((tag) => tag !== "partially picked"),
                    "picked",
                    timestamp,
                  ]),
                ),
              }
            : i,
        ),
      );
    }

    const currentIndex = getFilteredItems().findIndex(
      (i) => i.lineItemId === item.lineItemId,
    );
    const nextItem = getFilteredItems()[currentIndex + 1];
    if (nextItem) {
      setActiveLineId(nextItem.lineItemId);
    }
  };

  const openPrint = (item: CutListItem, includeBin: boolean) => {
    const url = `/print-label-both?orderName=${encodeURIComponent(item.orderName)}&productTitle=${encodeURIComponent(item.productTitle)}&variantTitle=${encodeURIComponent(item.variantTitle || "")}&quantity=${item.quantity}&sku=${encodeURIComponent(item.sku || "")}&barcode=${encodeURIComponent(item.barcode || "")}&includeBin=true`;

    if (includeBin && !item.orderTags.some((t) => t.toLowerCase() === "printed")) {
      submitTagsAdd(item.orderId, ["printed"]);
      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, "printed"])),
              }
            : i,
        ),
      );
    }

    setPrintedLines((prev) => new Set(prev).add(item.lineItemId));
    setReadyToPrint((prev) => {
      const next = new Set(prev);
      next.delete(item.lineItemId);
      return next;
    });

    window.open(url, "_blank");
  };

  const stats = getSummaryStats();
  const filteredItems = getFilteredItems();

  if (error) {
    return (
      <s-page heading="Fulfillment Cut List" inlineSize="large">
        <s-banner tone="critical">
          <s-text>{error}</s-text>
        </s-banner>
      </s-page>
    );
  }

  return (
    <s-page heading="Fulfillment Cut List" inlineSize="large">
      <s-section>
        <s-stack gap="base" direction="inline">
          <s-box
            padding="base"
            background={currentFilter === "rush" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("rush")}>
              <s-stack gap="small">
                <s-text color="subdued">Rush Orders</s-text>
                <s-text type="strong" tone="critical">
                  {stats.rushOrders}
                </s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "pickedToday" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("pickedToday")}>
              <s-stack gap="small">
                <s-text color="subdued">Orders Cut Today</s-text>
                <s-text type="strong">{stats.ordersCutToday}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "pickedToday" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("pickedToday")}>
              <s-stack gap="small">
                <s-text color="subdued">Items Cut Today</s-text>
                <s-text type="strong">{stats.itemsCutToday}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "all" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("all")}>
              <s-stack gap="small">
                <s-text color="subdued">Total Orders to Pick</s-text>
                <s-text type="strong">{stats.totalOrders}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "all" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("all")}>
              <s-stack gap="small">
                <s-text color="subdued">Total Cuts to Pick</s-text>
                <s-text type="strong">{stats.totalCuts}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "rollEnds" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("rollEnds")}>
              <s-stack gap="small">
                <s-text color="subdued">Roll Ends Only</s-text>
                <s-text type="strong">{stats.rollEndsOnly}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
            padding="base"
            background={currentFilter === "swatches" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("swatches")}>
              <s-stack gap="small">
                <s-text color="subdued">Swatches Only</s-text>
                <s-text type="strong">{stats.swatchesOnly}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>

          <s-box
  padding="base"
  background={currentFilter === "multiple" ? "subdued" : "base"}
  borderWidth="base"
  borderColor="base"
  borderRadius="base"
>
  <s-clickable onClick={() => setCurrentFilter("multiple")}>
    <s-stack gap="small">
      <s-text color="subdued">Multiple Orders</s-text>
      <s-text type="strong">
        {
          cutListItems.filter((item) =>
            item.orderTags.some(
              (t) => t.toLowerCase() === "multiple orders"
            )
          ).length
        }
      </s-text>
    </s-stack>
  </s-clickable>
</s-box>

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack gap="small">
              <s-text color="subdued">Last updated</s-text>
              <s-text type="strong">{secondsSinceUpdate} seconds ago</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {(currentFilter === "pickedToday" || currentFilter === "rush") && (
        <s-section>
          <s-button variant="secondary" onClick={() => setCurrentFilter("all")}>
            Back to Cut List
          </s-button>
        </s-section>
      )}

      <s-section padding="none">
        <s-table
          paginate={false}
          loading={loading}
          hasNextPage={false}
          hasPreviousPage={false}
        >
          <s-table-header-row>
            <s-table-header listSlot="labeled"></s-table-header>
            <s-table-header listSlot="primary">Order Number</s-table-header>
            <s-table-header listSlot="labeled">Customer Name</s-table-header>
            <s-table-header listSlot="labeled">Bin Number</s-table-header>
            <s-table-header listSlot="labeled">Product SKU</s-table-header>
            <s-table-header listSlot="labeled">Image</s-table-header>
            <s-table-header listSlot="labeled">Product Title</s-table-header>
            <s-table-header listSlot="labeled">Quantity</s-table-header>
            <s-table-header listSlot="labeled">Order Time</s-table-header>
            <s-table-header listSlot="labeled">Product Count</s-table-header>
            <s-table-header listSlot="labeled">
              {currentFilter === "pickedToday" ? "Picked By" : "Actions"}
            </s-table-header>
            <s-table-header listSlot="labeled">Order Tags</s-table-header>
            <s-table-header listSlot="labeled"></s-table-header>
          </s-table-header-row>

          <s-table-body>
            {filteredItems.length === 0 && !loading ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {currentFilter === "pickedToday"
                      ? "No orders picked today"
                      : "No orders to pick"}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ) : (
              filteredItems.map((item, index) => {
                const itemKey = `${item.lineItemId}`;
                const orderIdNum = item.orderId.split("/").pop();
                const customerIdNum = item.customerId?.split("/").pop();
                const productIdNum = item.productId.split("/").pop();
                const isActive = activeLineId === item.lineItemId;
                const isRush = isRushOrder(item.orderTags);
                const isMultipleOrders = item.orderTags.some(
                  (t) => t.toLowerCase() === "multiple orders"
                );
                const alreadyPrinted = item.orderTags.some(
                  (t) => t.toLowerCase() === "printed",
                );

                const prevItem = filteredItems[index - 1];
const isNewCustomerGroup =
  index === 0 || prevItem?.customerId !== item.customerId;

const customerGroupIndex = filteredItems
  .slice(0, index + 1)
  .reduce((count, currentItem, currentIndex, arr) => {
    if (
      currentIndex === 0 ||
      arr[currentIndex - 1].customerId !== currentItem.customerId
    ) {
      return count + 1;
    }
    return count;
  }, 0);

const multipleGroupBackground =
  currentFilter === "multiple"
    ? customerGroupIndex % 2 === 0
      ? "subdued"
      : "base"
    : "transparent";

                return (
                  <s-table-row
  key={itemKey}
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
<s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      {isActive && <s-badge tone="success">✓</s-badge>}
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                      <s-stack gap="small" direction="inline">
  {isRush && <s-badge tone="critical">RUSH</s-badge>}
  {isMultipleOrders && <s-badge tone="info">MULTIPLE ORDERS</s-badge>}
  {item.hasHold && <s-badge tone="critical">FULFILLMENT HOLD</s-badge>}
  <s-link href={`shopify://admin/orders/${orderIdNum}`}>
    {item.orderName}
  </s-link>
</s-stack>
                      </s-clickable>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
<s-box
  padding="small"
  background={isActive ? "strong" : multipleGroupBackground}
  borderRadius="small"
  borderBlockStartWidth={
    currentFilter === "multiple" && isNewCustomerGroup ? "base" : "none"
  }
  borderColor="base"
>
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {item.customerId ? (
                            <s-link href={`shopify://admin/customers/${customerIdNum}`}>
                              {item.customerName}
                            </s-link>
                          ) : (
                            <s-text>{item.customerName}</s-text>
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-text>{item.binNumber || "-"}</s-text>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-stack gap="small" direction="inline">
                            <s-link href={`shopify://admin/products/${productIdNum}`}>
                              {item.sku || "-"}
                            </s-link>
                            {getVariantTypeBadge(item.variantTitle)}
                          </s-stack>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      {item.productImage ? (
                        <s-clickable
                          onClick={() =>
                            setPreviewImage({
                              url: item.productImage!,
                              alt: item.productImageAlt || item.productTitle,
                            })
                          }
                        >
                          <s-thumbnail
                            src={item.productImage}
                            alt={item.productImageAlt || item.productTitle}
                            size="small-200"
                          />
                        </s-clickable>
                      ) : (
                        <s-thumbnail alt="No image" size="small-200" />
                      )}
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-link href={`shopify://admin/products/${productIdNum}`}>
                            {item.productTitle}
                          </s-link>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {!item.variantTitle?.includes("By the Yard") &&
                          item.quantity > 1 ? (
                            <s-badge tone="critical">⚠️ {item.quantity} units</s-badge>
                          ) : (
                            formatQuantity(item.quantity, item.variantTitle)
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-text>{formatTimestamp(item.orderCreatedAt)}</s-text>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-button variant="tertiary" onClick={() => handleProductCountClick(item)}>
                        {item.allLineItems.filter((li) => li.sku !== VIRTUAL_SKU).length} items
                      </s-button>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      {currentFilter === "pickedToday" ? (
                        <s-text>{getPickedByName(item.orderTags)}</s-text>
                      ) : printedLines.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Label sent to printer</s-badge>
                          <s-button variant="tertiary" onClick={() => openPrint(item, true)}>
                            Reprint
                          </s-button>
                        </s-stack>
                      ) : readyToPrint.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Scan verified</s-badge>
                          <s-button
                            variant="primary"
                            onClick={() => openPrint(item, !alreadyPrinted)}
                          >
                            Print Labels
                          </s-button>
                        </s-stack>
                      ) : isActive ? (
                        <s-stack gap="small">
                          <s-text-field
                            label="Scan Barcode"
                            labelAccessibilityVisibility="exclusive"
                            placeholder="Scan barcode to verify item"
                            value={barcodeInputs[itemKey] || ""}
                            onInput={(e) =>
                              handleBarcodeScan(itemKey, e.currentTarget.value, item)
                            }
                          />
                          {barcodeErrors[itemKey] === "NO_BARCODE" && (
                            <s-banner tone="warning">
                              <s-text>
                                No barcode on file. Please add a barcode to this product variant in
                                Shopify before continuing fulfillment.
                              </s-text>
                            </s-banner>
                          )}
                          {barcodeErrors[itemKey] === "MISMATCH" && (
                            <s-banner tone="critical">
                              <s-text>
                                ⚠️ WRONG ITEM SCANNED. Barcode does not match. Please scan the
                                correct item.
                              </s-text>
                            </s-banner>
                          )}
                        </s-stack>
                      ) : (
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-text color="subdued">Click to activate</s-text>
                        </s-clickable>
                      )}
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                      <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
  <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
    <s-text>{item.orderTags.join(", ") || "-"}</s-text>
  </s-clickable>
</s-table-cell>
                      </s-clickable>
                    </s-table-cell>

                    <s-table-cell
  style={{
    background: isActive ? "strong" : multipleGroupBackground,
  }}
>
                      {isActive && <s-badge tone="success">✓</s-badge>}
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      <s-modal
        id="product-count-modal"
        heading={`Items in ${productCountModalOrderName}`}
        ref={(el) => {
          if (el && showProductCountModal) {
            el.showOverlay();
          } else if (el && !showProductCountModal) {
            el.hideOverlay();
          }
        }}
        onHide={() => setShowProductCountModal(false)}
      >
        <s-stack gap="small">
          {productCountModalItems
            .filter((li) => li.sku !== VIRTUAL_SKU)
            .map((li) => {
              const productIdNum = li.product.id.split("/").pop();
              return (
                <s-text key={li.id}>
                  <s-link href={`shopify://admin/products/${productIdNum}`}>
                    {li.title} — {li.sku}
                  </s-link>
                </s-text>
              );
            })}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => setShowProductCountModal(false)}
        >
          Close
        </s-button>
      </s-modal>

      <s-modal
        id="image-preview-modal"
        heading={previewImage?.alt || "Product Image"}
        ref={(el) => {
          if (el && previewImage) {
            el.showOverlay();
          } else if (el && !previewImage) {
            el.hideOverlay();
          }
        }}
        onHide={() => setPreviewImage(null)}
      >
        {previewImage && (
          <s-box padding="base">
            <s-image src={previewImage.url} alt={previewImage.alt} objectFit="contain" />
          </s-box>
        )}
        <s-button slot="primary-action" variant="primary" onClick={() => setPreviewImage(null)}>
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}
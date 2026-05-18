// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from "react";
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
  productType: string | null;
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
  productType: string | null;
  sku: string;
  variantTitle: string | null;
  quantity: number;
  variantId: string;
  barcode: string | null;
  binNumber: string;
  fabricLength: string | null;
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
    if (isPickedByTag(order.tags ?? [])) continue;
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
      const fabricLength =
        lineItem.variant?.metafields?.edges.find(
          (e) => e.node.key === "fabric_length",
        )?.node.value || null;

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
        productType: lineItem.product?.productType || null,
        fabricLength,
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
                    productType
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
    `(fulfillment_status:unfulfilled OR fulfillment_status:on_hold OR fulfillment_status:partial) -status:cancelled -tag:picked -tag:'picked by EasyScan'`,
  );

  const pickedTodayResult = await queryOrders(
    admin,
    `(tag:picked OR tag:'partially picked') -fulfillment_status:fulfilled`,
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
    const newCutListItems = data.cutListItems || [];
    const newPickedTodayItems = data.pickedTodayItems || [];
    setCutListItems(newCutListItems);
    setPickedTodayItems(newPickedTodayItems);
    setLastUpdated(new Date());

    const persistedPicked = new Set<string>();
    for (const item of [...newCutListItems, ...newPickedTodayItems]) {
      const numericId = item.lineItemId.split("/").pop();
      if (!numericId) continue;
      const tagToFind = `picked-line:${numericId}`.toLowerCase();
      if (item.orderTags.some((t) => t.toLowerCase() === tagToFind)) {
        persistedPicked.add(item.lineItemId);
      }
    }
    setPickedItems((prev) => {
      const next = new Set(prev);
      persistedPicked.forEach((id) => next.add(id));
      return next;
    });

    const persistedPrinted = new Set<string>();
    for (const item of [...newCutListItems, ...newPickedTodayItems]) {
      if (!persistedPicked.has(item.lineItemId)) continue;
      if (item.orderTags.some((t) => t.toLowerCase() === "printed")) {
        persistedPrinted.add(item.lineItemId);
      }
    }
    setPrintedLines((prev) => {
      const next = new Set(prev);
      persistedPrinted.forEach((id) => next.add(id));
      return next;
    });
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
    | "all"
    | "rush"
    | "rollEnds"
    | "swatches"
    | "totalSwatches"
    | "pickedToday"
    | "multiple"
    | "hold"
    | "readyToShip"
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

  const holdItems = useMemo(() => {
    const seen = new Map<string, CutListItem>();
    for (const item of cutListItems) {
      if (item.hasHold) seen.set(item.lineItemId, item);
    }
    for (const item of pickedTodayItems) {
      if (item.hasHold && !seen.has(item.lineItemId)) {
        seen.set(item.lineItemId, item);
      }
    }
    return Array.from(seen.values());
  }, [cutListItems, pickedTodayItems]);

  const remainingByOrder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of cutListItems) {
      if (item.sku === VIRTUAL_SKU) continue;
      if (pickedItems.has(item.lineItemId)) continue;
      counts.set(item.orderId, (counts.get(item.orderId) || 0) + 1);
    }
    return counts;
  }, [cutListItems, pickedItems]);

  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const [noteModalContent, setNoteModalContent] = useState<{
    orderName: string;
    note: string;
  } | null>(null);
  const [acknowledgedNotes, setAcknowledgedNotes] = useState<Set<string>>(new Set());
  const [readyToShipModalOrderId, setReadyToShipModalOrderId] = useState<
    string | null
  >(null);
  const [readyToShipSelections, setReadyToShipSelections] = useState<Set<string>>(
    new Set(),
  );
  const scanInputRef = useRef<any>(null);

  useEffect(() => {
    if (!activeLineId) return;
    const t = setTimeout(() => {
      scanInputRef.current?.focus?.();
    }, 50);
    return () => clearTimeout(t);
  }, [activeLineId]);

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
          <s-text type="strong">{(quantity / 4).toFixed(2)} yds</s-text>
          <s-text>{quantity} units</s-text>
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

  function hasReadyToShipTag(item: CutListItem): boolean {
    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return false;
    const tag = `ready-to-ship:${numericId}`.toLowerCase();
    return item.orderTags.some((t) => t.toLowerCase() === tag);
  }

  function isSwatch(item: CutListItem): boolean {
    if (item.variantTitle?.toLowerCase().includes("swatch sample")) return true;
    if (item.sku.toLowerCase().includes("swatch")) return true;
    if (item.fabricLength?.toLowerCase().includes("swatch sample")) return true;
    return false;
  }

  function isItemCut(item: CutListItem): boolean {
    const isOrderFullyPicked = item.orderTags.some(
      (t) => t.toLowerCase() === "picked",
    );
    if (isOrderFullyPicked) return true;

    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return false;
    const lineTag = `picked-line:${numericId}`.toLowerCase();
    return item.orderTags.some((t) => t.toLowerCase() === lineTag);
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

  const cutListItemsVisible = cutListItems.filter(
    (item) => !hasReadyToShipTag(item),
  );

  const getFilteredItems = (): CutListItem[] => {
    if (currentFilter === "pickedToday") {
      return pickedTodayItems.filter(
        (item) => isItemCut(item) && item.quantity > 0,
      );
    }

    if (currentFilter === "rush") {
      return processRushItems(rushOrders);
    }

    if (currentFilter === "multiple") {
      const multipleItems = cutListItemsVisible.filter((item) =>
        item.orderTags.some((t) => t.toLowerCase() === "multiple orders"),
      );

      return applyCustomerOnlySort(multipleItems);
    }

    if (currentFilter === "hold") {
      return applyCustomerOnlySort(holdItems);
    }

    if (currentFilter === "readyToShip") {
      const readyItems = pickedTodayItems.filter(
        (item) =>
          (item.orderTags.some((t) => t.toLowerCase() === "picked") ||
            hasReadyToShipTag(item)) &&
          !item.hasHold &&
          item.quantity > 0,
      );
      const orderGroups = new Map<string, CutListItem[]>();
      for (const item of readyItems) {
        if (!orderGroups.has(item.orderId)) {
          orderGroups.set(item.orderId, []);
        }
        orderGroups.get(item.orderId)!.push(item);
      }
      const sortedGroups = Array.from(orderGroups.values()).sort(
        (a, b) =>
          new Date(a[0].orderCreatedAt).getTime() -
          new Date(b[0].orderCreatedAt).getTime(),
      );
      return sortedGroups.flat();
    }

    const allItems = applyRushFirstSort(cutListItemsVisible);

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
        const allAreSwatches = items.every((item) => isSwatch(item));
        if (allAreSwatches) {
          swatchOrders.add(orderId);
        }
      });

      return allItems.filter((item) => swatchOrders.has(item.orderId));
    }

    if (currentFilter === "totalSwatches") {
      return allItems.filter((item) => isSwatch(item));
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
      (item) => item.sku !== VIRTUAL_SKU && !hasReadyToShipTag(item),
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

    const cutLogItems = pickedTodayItems.filter(
      (item) =>
        item.sku !== VIRTUAL_SKU && isItemCut(item) && item.quantity > 0,
    );
    const uniqueCutLogOrders = new Set(
      cutLogItems.map((item) => item.orderId),
    );

    const readyToShipOrders = new Set(
      pickedTodayItems
        .filter((item) => {
          if (item.sku === VIRTUAL_SKU) return false;
          if (item.hasHold) return false;
          if (item.quantity === 0) return false;
          const orderFullyPicked = item.orderTags.some(
            (t) => t.toLowerCase() === "picked",
          );
          return orderFullyPicked || hasReadyToShipTag(item);
        })
        .map((item) => item.orderId),
    );

    const totalSwatchesCount = filteredCutListItems.filter((item) =>
      isSwatch(item),
    ).length;

    return {
      rushOrders: rushOrders.length,
      ordersCutLog: uniqueCutLogOrders.size,
      itemsCutLog: cutLogItems.length,
      totalOrders: uniqueOrders.size,
      totalCuts,
      rollEndsOnly: rollEndsOnlyCount,
      swatchesOnly: swatchesOnlyCount,
      totalSwatches: totalSwatchesCount,
      readyToShip: readyToShipOrders.size,
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

    if (!item.barcode && !item.sku) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: "NO_BARCODE" }));
      return;
    }

    const matchesBarcode = !!item.barcode && value === item.barcode;
    const matchesSku = !!item.sku && value === item.sku;
    if (!matchesBarcode && !matchesSku) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: "MISMATCH" }));
      return;
    }

    setReadyToPrint((prev) => new Set(prev).add(item.lineItemId));
    setBarcodeInputs((prev) => ({ ...prev, [itemKey]: "" }));

    if (item.orderNote && !acknowledgedNotes.has(item.orderId)) {
      setNoteModalContent({
        orderName: item.orderName,
        note: item.orderNote,
      });
      setAcknowledgedNotes((prev) => new Set(prev).add(item.orderId));
    }
  };

  const openPrint = (
    item: CutListItem,
    includeBin: boolean,
    options?: { skipWindow?: boolean; skipCut?: boolean },
  ) => {
    const skipWindow = options?.skipWindow ?? false;
    const skipCut = options?.skipCut ?? false;
    const includeCut = !skipCut;
    const url = `/print-label-both?orderName=${encodeURIComponent(item.orderName)}&productTitle=${encodeURIComponent(item.productTitle)}&variantTitle=${encodeURIComponent(item.variantTitle || "")}&quantity=${item.quantity}&sku=${encodeURIComponent(item.sku || "")}&barcode=${encodeURIComponent(item.barcode || "")}&includeBin=${includeBin}&includeCut=${includeCut}`;

    const orderItems = cutListItems.filter((i) => i.orderId === item.orderId);
    const pickedCount = orderItems.filter(
      (i) => pickedItems.has(i.lineItemId) || i.lineItemId === item.lineItemId,
    ).length;
    const totalCount = orderItems.filter((i) => i.sku !== VIRTUAL_SKU).length;
    const timestamp = new Date().toISOString();
    const numericLineId = item.lineItemId.split("/").pop() || item.lineItemId;
    const lineItemTag = `picked-line:${numericLineId}`;
    const orderHadPrintedTag = item.orderTags.some(
      (t) => t.toLowerCase() === "printed",
    );
    const printedTag = includeBin && !orderHadPrintedTag ? ["printed"] : [];

    if (pickedCount === totalCount) {
      const tagsToAdd = ["picked", timestamp, lineItemTag, ...printedTag];
      submitTagsRemove(item.orderId, ["partially picked"]);
      submitTagsAdd(item.orderId, tagsToAdd);

      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(
                  new Set([
                    ...i.orderTags.filter((tag) => tag !== "partially picked"),
                    ...tagsToAdd,
                  ]),
                ),
              }
            : i,
        ),
      );

      setCompletionMessage(
        `Order ${item.orderName} is complete. All items cut.`,
      );
    } else if (pickedCount === 1) {
      const tagsToAdd = [
        "partially picked",
        timestamp,
        lineItemTag,
        ...printedTag,
      ];
      submitTagsAdd(item.orderId, tagsToAdd);

      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, ...tagsToAdd])),
              }
            : i,
        ),
      );
    } else {
      const tagsToAdd = [lineItemTag, ...printedTag];
      submitTagsAdd(item.orderId, tagsToAdd);

      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === item.orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, ...tagsToAdd])),
              }
            : i,
        ),
      );
    }

    setPickedItems((prev) => new Set(prev).add(item.lineItemId));
    setPrintedLines((prev) => new Set(prev).add(item.lineItemId));
    setReadyToPrint((prev) => {
      const next = new Set(prev);
      next.delete(item.lineItemId);
      return next;
    });

    if (!skipWindow) {
      window.open(url, "_blank");
    }

    const itemsNow = getFilteredItems();
    const currentIndex = itemsNow.findIndex(
      (i) => i.lineItemId === item.lineItemId,
    );
    const nextItem = itemsNow[currentIndex + 1];
    if (nextItem) {
      setActiveLineId(nextItem.lineItemId);
      if (
        nextItem.sku &&
        nextItem.sku === item.sku &&
        nextItem.sku !== VIRTUAL_SKU &&
        !isSwatch(nextItem)
      ) {
        setReadyToPrint((prev) => new Set(prev).add(nextItem.lineItemId));
      }
    }
  };

  const reprintLabel = (item: CutListItem, mode: "bin" | "cut") => {
    const params = new URLSearchParams({
      orderName: item.orderName,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle || "",
      quantity: String(item.quantity),
      sku: item.sku || "",
      barcode: item.barcode || "",
      includeBin: mode === "bin" ? "true" : "false",
      includeCut: mode === "cut" ? "true" : "false",
    });
    window.open(`/print-label-both?${params.toString()}`, "_blank");
  };

  const openReadyToShipModal = (orderId: string) => {
    setReadyToShipModalOrderId(orderId);
    setReadyToShipSelections(new Set());
  };

  const toggleReadyToShipSelection = (lineItemId: string) => {
    setReadyToShipSelections((prev) => {
      const next = new Set(prev);
      if (next.has(lineItemId)) next.delete(lineItemId);
      else next.add(lineItemId);
      return next;
    });
  };

  const confirmReadyToShip = () => {
    if (!readyToShipModalOrderId) return;
    const selectedIds = Array.from(readyToShipSelections);
    if (selectedIds.length === 0) {
      setReadyToShipModalOrderId(null);
      return;
    }

    const newTags = selectedIds.map((id) => {
      const numericId = id.split("/").pop() || id;
      return `ready-to-ship:${numericId}`;
    });

    submitTagsAdd(readyToShipModalOrderId, newTags);

    setCutListItems((prev) =>
      prev.map((i) =>
        i.orderId === readyToShipModalOrderId
          ? {
              ...i,
              orderTags: Array.from(new Set([...i.orderTags, ...newTags])),
            }
          : i,
      ),
    );

    setPickedTodayItems((prev) =>
      prev.map((i) =>
        i.orderId === readyToShipModalOrderId
          ? {
              ...i,
              orderTags: Array.from(new Set([...i.orderTags, ...newTags])),
            }
          : i,
      ),
    );

    setReadyToShipModalOrderId(null);
    setReadyToShipSelections(new Set());
  };

  const reprintSwatchBundle = (swatches: CutListItem[]) => {
    if (swatches.length === 0) return;
    const orderName = swatches[0].orderName;
    const itemsParam = encodeURIComponent(
      JSON.stringify(
        swatches.map((s) => ({
          productTitle: s.productTitle,
          variantTitle: s.variantTitle,
          quantity: s.quantity,
          sku: s.sku,
          barcode: s.barcode,
        })),
      ),
    );
    window.open(
      `/print-label-both?orderName=${encodeURIComponent(orderName)}&items=${itemsParam}&includeBin=true&includeCut=true`,
      "_blank",
    );
  };

  const printSwatchBundle = (swatches: CutListItem[]) => {
    if (swatches.length === 0) return;
    const first = swatches[0];
    const orderId = first.orderId;
    const orderName = first.orderName;

    const itemsParam = encodeURIComponent(
      JSON.stringify(
        swatches.map((s) => ({
          productTitle: s.productTitle,
          variantTitle: s.variantTitle,
          quantity: s.quantity,
          sku: s.sku,
          barcode: s.barcode,
        })),
      ),
    );

    const orderHadPrintedTag = first.orderTags.some(
      (t) => t.toLowerCase() === "printed",
    );
    const includeBin = true;

    const url = `/print-label-both?orderName=${encodeURIComponent(orderName)}&items=${itemsParam}&includeBin=${includeBin}&includeCut=true`;

    const orderItemsInList = cutListItems.filter((i) => i.orderId === orderId);
    const swatchIds = new Set(swatches.map((s) => s.lineItemId));
    const pickedAfter = new Set(pickedItems);
    swatches.forEach((s) => pickedAfter.add(s.lineItemId));
    const pickedCount = orderItemsInList.filter((i) =>
      pickedAfter.has(i.lineItemId),
    ).length;
    const totalCount = orderItemsInList.filter(
      (i) => i.sku !== VIRTUAL_SKU,
    ).length;
    const timestamp = new Date().toISOString();
    const swatchLineTags = swatches.map((s) => {
      const numericId = s.lineItemId.split("/").pop() || s.lineItemId;
      return `picked-line:${numericId}`;
    });
    const printedTag = orderHadPrintedTag ? [] : ["printed"];
    const hadPartialTag = first.orderTags.some(
      (t) => t.toLowerCase() === "partially picked",
    );

    if (pickedCount === totalCount) {
      const tagsToAdd = ["picked", timestamp, ...swatchLineTags, ...printedTag];
      submitTagsRemove(orderId, ["partially picked"]);
      submitTagsAdd(orderId, tagsToAdd);
      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === orderId
            ? {
                ...i,
                orderTags: Array.from(
                  new Set([
                    ...i.orderTags.filter((tag) => tag !== "partially picked"),
                    ...tagsToAdd,
                  ]),
                ),
              }
            : i,
        ),
      );
      setCompletionMessage(
        `Order ${orderName} is complete. All items cut.`,
      );
    } else if (!hadPartialTag) {
      const tagsToAdd = [
        "partially picked",
        timestamp,
        ...swatchLineTags,
        ...printedTag,
      ];
      submitTagsAdd(orderId, tagsToAdd);
      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, ...tagsToAdd])),
              }
            : i,
        ),
      );
    } else {
      const tagsToAdd = [...swatchLineTags, ...printedTag];
      submitTagsAdd(orderId, tagsToAdd);
      setCutListItems((prev) =>
        prev.map((i) =>
          i.orderId === orderId
            ? {
                ...i,
                orderTags: Array.from(new Set([...i.orderTags, ...tagsToAdd])),
              }
            : i,
        ),
      );
    }

    setPickedItems((prev) => {
      const next = new Set(prev);
      swatches.forEach((s) => next.add(s.lineItemId));
      return next;
    });
    setPrintedLines((prev) => {
      const next = new Set(prev);
      swatches.forEach((s) => next.add(s.lineItemId));
      return next;
    });
    setReadyToPrint((prev) => {
      const next = new Set(prev);
      swatches.forEach((s) => next.delete(s.lineItemId));
      return next;
    });

    window.open(url, "_blank");

    const itemsNow = getFilteredItems();
    const lastSwatchIdx = itemsNow.reduce<number>((maxIdx, it, idx) => {
      return swatchIds.has(it.lineItemId) ? Math.max(maxIdx, idx) : maxIdx;
    }, -1);
    const nextItem = itemsNow[lastSwatchIdx + 1];
    if (nextItem) {
      setActiveLineId(nextItem.lineItemId);
    }
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
            background={currentFilter === "totalSwatches" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("totalSwatches")}>
              <s-stack gap="small">
                <s-text color="subdued">Total Swatches to Pick</s-text>
                <s-text type="strong">{stats.totalSwatches}</s-text>
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
  background={currentFilter === "hold" ? "subdued" : "base"}
  borderWidth="base"
  borderColor="base"
  borderRadius="base"
>
  <s-clickable onClick={() => setCurrentFilter("hold")}>
    <s-stack gap="small">
      <s-text color="subdued">Fulfillment Hold</s-text>
      <s-text type="strong" tone="critical">
        {holdItems.length}
      </s-text>
    </s-stack>
  </s-clickable>
</s-box>

          <s-box
  padding="base"
  background={currentFilter === "readyToShip" ? "subdued" : "base"}
  borderWidth="base"
  borderColor="base"
  borderRadius="base"
>
  <s-clickable onClick={() => setCurrentFilter("readyToShip")}>
    <s-stack gap="small">
      <s-text color="subdued">Ready to Ship</s-text>
      <s-text type="strong" tone="success">{stats.readyToShip}</s-text>
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
                <s-text color="subdued">Orders Cut Log</s-text>
                <s-text type="strong">{stats.ordersCutLog}</s-text>
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
                <s-text color="subdued">Items Cut Log</s-text>
                <s-text type="strong">{stats.itemsCutLog}</s-text>
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

      {(currentFilter === "pickedToday" ||
        currentFilter === "rush" ||
        currentFilter === "readyToShip") && (
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
            <s-table-header listSlot="primary">Product SKU</s-table-header>
            <s-table-header listSlot="labeled">Quantity</s-table-header>
            <s-table-header listSlot="labeled">Bin Number</s-table-header>
            <s-table-header listSlot="labeled">Image</s-table-header>
            <s-table-header listSlot="labeled">Order Number</s-table-header>
            <s-table-header listSlot="labeled">Customer Name</s-table-header>
            <s-table-header listSlot="labeled">Order Note</s-table-header>
            <s-table-header listSlot="labeled">Product Title</s-table-header>
            <s-table-header listSlot="labeled">Order Time</s-table-header>
            <s-table-header listSlot="labeled">Product Count</s-table-header>
            <s-table-header listSlot="labeled">
              {currentFilter === "pickedToday" || currentFilter === "readyToShip"
                ? "Picked By"
                : "Actions"}
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
                      ? "No cut items in log"
                      : currentFilter === "readyToShip"
                        ? "No orders ready to ship"
                        : "No orders to pick"}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ) : (
              filteredItems.map((item, index) => {
                const isSwatchItem = isSwatch(item);
                const firstSwatchIdxForOrder = isSwatchItem
                  ? filteredItems.findIndex(
                      (i) => i.orderId === item.orderId && isSwatch(i),
                    )
                  : -1;
                if (isSwatchItem && firstSwatchIdxForOrder !== index) {
                  return null;
                }
                const swatchesForOrder = isSwatchItem
                  ? filteredItems.filter(
                      (i) => i.orderId === item.orderId && isSwatch(i),
                    )
                  : [];
                const isBundleRow = isSwatchItem && swatchesForOrder.length > 0;

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
                const isFinalCut =
                  (remainingByOrder.get(item.orderId) || 0) === 1 &&
                  !pickedItems.has(item.lineItemId);
                const isInProgress =
                  readyToPrint.has(item.lineItemId) &&
                  !pickedItems.has(item.lineItemId);

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

const orderGroupIndex = filteredItems
  .slice(0, index + 1)
  .reduce((count, currentItem, currentIndex, arr) => {
    if (
      currentIndex === 0 ||
      arr[currentIndex - 1].orderId !== currentItem.orderId
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
    : currentFilter === "readyToShip"
      ? orderGroupIndex % 2 === 0
        ? "strong"
        : "base"
      : "transparent";

const showOrderGroupBorder =
  currentFilter === "readyToShip" &&
  index > 0 &&
  filteredItems[index - 1]?.orderId !== item.orderId;

const cellStyle = {
  background: isActive ? "strong" : multipleGroupBackground,
  borderTop: showOrderGroupBorder ? "4px solid #1f1f1f" : undefined,
};

                return (
                  <s-table-row
  key={itemKey}
  style={cellStyle}
>
<s-table-cell
  style={cellStyle}
>
                      {isActive && <s-badge tone="success">✓</s-badge>}
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {isBundleRow ? (
                            <s-stack gap="small" direction="inline">
                              <s-text>{swatchesForOrder.length} swatches</s-text>
                              <s-badge tone="warning">Swatch Bundle</s-badge>
                            </s-stack>
                          ) : (
                            <s-stack gap="small" direction="inline">
                              <s-link href={`shopify://admin/products/${productIdNum}`}>
                                {item.sku || "-"}
                              </s-link>
                              {getVariantTypeBadge(item.variantTitle)}
                            </s-stack>
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {isBundleRow ? (
                            <s-text>{swatchesForOrder.length} swatches</s-text>
                          ) : !item.variantTitle?.includes("By the Yard") &&
                          item.quantity > 1 ? (
                            <s-badge tone="critical">⚠️ {item.quantity} units</s-badge>
                          ) : (
                            formatQuantity(item.quantity, item.variantTitle)
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
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
  style={cellStyle}
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
                          <img
                            src={item.productImage}
                            alt={item.productImageAlt || item.productTitle}
                            style={{
                              width: "150px",
                              height: "150px",
                              objectFit: "cover",
                              borderRadius: "8px",
                              display: "block",
                            }}
                          />
                        </s-clickable>
                      ) : (
                        <s-thumbnail alt="No image" size="small-200" />
                      )}
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                      <s-stack gap="small" direction="inline">
  {isRush && <s-badge tone="critical">RUSH</s-badge>}
  {isMultipleOrders && <s-badge tone="info">MULTIPLE ORDERS</s-badge>}
  {item.hasHold && <s-badge tone="critical">FULFILLMENT HOLD</s-badge>}
  {isFinalCut && (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        backgroundColor: "#7C3AED",
        color: "#FFFFFF",
        fontSize: "0.75rem",
        fontWeight: 600,
        borderRadius: "8px",
        lineHeight: 1.4,
        letterSpacing: "0.02em",
      }}
    >
      FINAL CUT
    </span>
  )}
  {isInProgress && <s-badge tone="warning">IN PROGRESS</s-badge>}
  {item.orderNote && <s-badge tone="caution">📝 NOTE</s-badge>}
  <s-link href={`shopify://admin/orders/${orderIdNum}`}>
    {item.orderName}
  </s-link>
</s-stack>
                      </s-clickable>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
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
  style={cellStyle}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        {item.orderNote ? (
                          <s-clickable
                            onClick={() =>
                              setNoteModalContent({
                                orderName: item.orderName,
                                note: item.orderNote!,
                              })
                            }
                          >
                            <s-text type="strong">📝 View note</s-text>
                          </s-clickable>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      <s-box
                        padding="small"
                        background={isActive ? "strong" : multipleGroupBackground}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {isBundleRow ? (
                            <s-text>
                              {swatchesForOrder
                                .map((s) => s.productTitle)
                                .join(", ")}
                            </s-text>
                          ) : (
                            <s-link href={`shopify://admin/products/${productIdNum}`}>
                              {item.productTitle}
                            </s-link>
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
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
  style={cellStyle}
>
                      <s-button variant="tertiary" onClick={() => handleProductCountClick(item)}>
                        {item.allLineItems.filter((li) => li.sku !== VIRTUAL_SKU).length} items
                      </s-button>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      {currentFilter === "pickedToday" ||
                      currentFilter === "readyToShip" ? (
                        <s-stack gap="small">
                          <s-text>{getPickedByName(item.orderTags)}</s-text>
                          <div style={{ textAlign: "center" }}>
                            <s-stack gap="small">
                              <s-clickable
                                onClick={() => reprintLabel(item, "bin")}
                              >
                                <s-badge>Reprint Bin Label</s-badge>
                              </s-clickable>
                              <s-clickable
                                onClick={() =>
                                  isBundleRow
                                    ? reprintSwatchBundle(swatchesForOrder)
                                    : reprintLabel(item, "cut")
                                }
                              >
                                <s-badge>Reprint Product Label</s-badge>
                              </s-clickable>
                            </s-stack>
                          </div>
                        </s-stack>
                      ) : printedLines.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Label sent to printer</s-badge>
                          <s-button
                            variant="tertiary"
                            onClick={() =>
                              isBundleRow
                                ? reprintSwatchBundle(swatchesForOrder)
                                : openPrint(item, true)
                            }
                          >
                            Reprint
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => openReadyToShipModal(item.orderId)}
                          >
                            Ready to Ship
                          </s-button>
                        </s-stack>
                      ) : isBundleRow ? (
                        isActive ? (
                          <s-stack gap="small">
                            <s-badge tone="success">✓ Active</s-badge>
                            <s-button
                              variant="primary"
                              onClick={() => printSwatchBundle(swatchesForOrder)}
                            >
                              Print Swatch Labels
                            </s-button>
                          </s-stack>
                        ) : (
                          <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                            <s-text color="subdued">Click to activate</s-text>
                          </s-clickable>
                        )
                      ) : readyToPrint.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Scan verified</s-badge>
                          {item.productType?.toLowerCase() === "roll end" ? (
                            alreadyPrinted ? (
                              <s-button
                                variant="primary"
                                onClick={() =>
                                  openPrint(item, false, { skipWindow: true })
                                }
                              >
                                Mark Already Printed
                              </s-button>
                            ) : (
                              <s-button
                                variant="primary"
                                onClick={() =>
                                  openPrint(item, true, { skipCut: true })
                                }
                              >
                                Print Bin Label
                              </s-button>
                            )
                          ) : (
                            <s-button
                              variant="primary"
                              onClick={() => openPrint(item, !alreadyPrinted)}
                            >
                              {alreadyPrinted ? "Print Product Label" : "Print Labels"}
                            </s-button>
                          )}
                        </s-stack>
                      ) : isActive ? (
                        <s-stack gap="small">
                          <s-text-field
                            ref={scanInputRef}
                            label="Scan Barcode"
                            labelAccessibilityVisibility="exclusive"
                            placeholder="Scan barcode or SKU"
                            value={barcodeInputs[itemKey] || ""}
                            onInput={(e) =>
                              handleBarcodeScan(itemKey, e.currentTarget.value, item)
                            }
                          />
                          {barcodeErrors[itemKey] === "NO_BARCODE" && (
                            <s-banner tone="warning">
                              <s-text>
                                No barcode or SKU on file. Please add one to this product variant in
                                Shopify before continuing fulfillment.
                              </s-text>
                            </s-banner>
                          )}
                          {barcodeErrors[itemKey] === "MISMATCH" && (
                            <s-banner tone="critical">
                              <s-text>
                                ⚠️ WRONG ITEM SCANNED. Barcode/SKU does not match. Please scan the
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
  style={cellStyle}
>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                      <s-table-cell
  style={cellStyle}
>
<s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
    {item.orderTags.length > 0 ? (
      <s-stack gap="small" direction="inline">
        {item.orderTags.map((tag) => (
          <s-badge key={tag}>{tag}</s-badge>
        ))}
      </s-stack>
    ) : (
      <s-text>-</s-text>
    )}
  </s-clickable>
</s-table-cell>
                      </s-clickable>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
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
        id="ready-to-ship-modal"
        heading="Mark items as Ready to Ship"
        ref={(el) => {
          if (el && readyToShipModalOrderId) {
            el.showOverlay();
          } else if (el && !readyToShipModalOrderId) {
            el.hideOverlay();
          }
        }}
        onHide={() => setReadyToShipModalOrderId(null)}
      >
        <s-box padding="base">
          <s-stack gap="small">
            {readyToShipModalOrderId
              ? cutListItems
                  .filter(
                    (i) =>
                      i.orderId === readyToShipModalOrderId &&
                      i.sku !== VIRTUAL_SKU,
                  )
                  .map((i) => {
                    const isPrinted = pickedItems.has(i.lineItemId);
                    const isSelected = readyToShipSelections.has(i.lineItemId);
                    return (
                      <s-clickable
                        key={i.lineItemId}
                        onClick={() =>
                          isPrinted && toggleReadyToShipSelection(i.lineItemId)
                        }
                      >
                        <s-stack gap="small" direction="inline">
                          <s-text type={isSelected ? "strong" : undefined}>
                            {isPrinted ? (isSelected ? "☑" : "☐") : "·"}
                          </s-text>
                          <s-text color={isPrinted ? "base" : "subdued"}>
                            {i.productTitle}
                            {i.variantTitle ? ` — ${i.variantTitle}` : ""}
                            {!isPrinted && " (not yet cut)"}
                          </s-text>
                        </s-stack>
                      </s-clickable>
                    );
                  })
              : null}
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={confirmReadyToShip}
        >
          Confirm
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => setReadyToShipModalOrderId(null)}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        id="order-note-modal"
        heading={`Note on Order ${noteModalContent?.orderName ?? ""}`}
        ref={(el) => {
          if (el && noteModalContent) {
            el.showOverlay();
          } else if (el && !noteModalContent) {
            el.hideOverlay();
          }
        }}
        onHide={() => setNoteModalContent(null)}
      >
        <s-box padding="base">
          <s-text>{noteModalContent?.note}</s-text>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => setNoteModalContent(null)}
        >
          Acknowledge
        </s-button>
      </s-modal>

      <s-modal
        id="completion-modal"
        heading="Order Complete"
        ref={(el) => {
          if (el && completionMessage) {
            el.showOverlay();
          } else if (el && !completionMessage) {
            el.hideOverlay();
          }
        }}
        onHide={() => setCompletionMessage(null)}
      >
        <s-box padding="base">
          <s-text>{completionMessage}</s-text>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => setCompletionMessage(null)}
        >
          OK
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
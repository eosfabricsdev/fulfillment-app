// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VIRTUAL_SKU = "85496775805861";

// Shopify caps order tags at 40 chars and SILENTLY rejects over-length tags (HTTP
// 200 + userErrors). The cut-line tag is "<prefix><14-digit line id>_<sku>", so the
// prefix length directly limits how much SKU fits. We use the short "picked:" prefix
// (vs the old "picked-line:") to leave ~18 chars for the SKU, still capping the whole
// tag at 40 so it always persists.
//
// Matching accepts BOTH "picked:" and the legacy "picked-line:" so orders cut before
// this change keep working. "picked:" is safe against the loader's `-tag:picked`
// filter: Shopify `tag:` is an exact match (proven — legacy "picked-line:" tags were
// never caught by `tag:picked`, or partial orders would have vanished).
const PICKED_LINE_PREFIX = "picked:";
const PICKED_LINE_PREFIXES = ["picked:", "picked-line:"];

function pickedLineTag(numericId: string, sku: string | null | undefined): string {
  const base = `${PICKED_LINE_PREFIX}${numericId}`;
  return sku ? `${base}_${sku}`.slice(0, 40) : base;
}

// True if `tag` is the picked-line tag for this numeric line id (new or legacy form).
function isPickedLineTagFor(tag: string, numericId: string): boolean {
  const lower = tag.toLowerCase();
  return PICKED_LINE_PREFIXES.some((prefix) => {
    const p = `${prefix}${numericId}`.toLowerCase();
    return lower === p || lower.startsWith(p + "_");
  });
}

// True if `tag` is any picked-line tag (new or legacy) — used to skip them.
function isAnyPickedLineTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  return PICKED_LINE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

type Metafield = {
  key: string;
  value: string;
  namespace: string;
};

type Variant = {
  id: string;
  barcode: string | null;
  inventoryQuantity: number;
  image: {
    url: string;
    altText: string | null;
  } | null;
  binNumber: { value: string } | null;
  colorCode: { value: string } | null;
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
  unfulfilledQuantity: number;
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
  displayFulfillmentStatus: string | null;
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
  colorCode: string | null;
  hasHold: boolean;
  displayFulfillmentStatus: string | null;
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
        if (lineItem.unfulfilledQuantity === 0) continue;
        if (lineItem.fulfillmentStatus?.toLowerCase() === "fulfilled") continue;
        if (lineItem.currentQuantity === 0) continue;
        if (isPickedByTag(order.tags ?? [])) continue;
      }
      
      if (lineItem.sku === VIRTUAL_SKU) continue;

      const binNumber = lineItem.variant?.binNumber?.value || "";
      const colorCode = lineItem.variant?.colorCode?.value || null;
      const fabricLength = null;

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
        displayFulfillmentStatus: order.displayFulfillmentStatus ?? null,
        allLineItems,
        productImage:
          lineItem.variant?.image?.url ||
          lineItem.product?.featuredImage?.url ||
          null,
        productImageAlt:
          lineItem.variant?.image?.altText ||
          lineItem.product?.featuredImage?.altText ||
          null,
        productType: lineItem.product?.productType || null,
        fabricLength,
        colorCode,
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
            displayFulfillmentStatus
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
                  unfulfilledQuantity
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
                    image {
                      url
                      altText
                    }
                    binNumber: metafield(namespace: "custom", key: "bin_number") {
                      value
                    }
                    colorCode: metafield(namespace: "custom", key: "color_code") {
                      value
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

  let staffMember: { id: string; name: string; email: string | null } | null =
    null;
  try {
    const staffResponse = await admin.graphql(
      `#graphql
      query GetCurrentStaffMember {
        currentStaffMember {
          id
          name
          email
        }
      }`,
    );
    const staffJson = await staffResponse.json();
    const sm = staffJson.data?.currentStaffMember;
    if (sm) {
      staffMember = {
        id: sm.id,
        name: sm.name,
        email: sm.email ?? null,
      };
    }
  } catch {
    // ignore — fall back to unknown
  }

  return {
    cutListItems,
    pickedTodayItems,
    pageInfo: mainOrdersResult.pageInfo,
    staffMember,
    employeeName: staffMember?.name || "Unknown",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  if (intent === "logCut") {
    const eventsJson = String(formData.get("events") || "[]");
    try {
      const events = JSON.parse(eventsJson) as Array<{
        cutterId?: string | null;
        cutterName: string;
        orderId: string;
        orderName?: string | null;
        lineItemId: string;
        sku?: string | null;
      }>;
      if (Array.isArray(events) && events.length > 0) {
        await prisma.cutEvent.createMany({
          data: events.map((e) => ({
            shop: session.shop,
            cutterId: e.cutterId ?? null,
            cutterName: e.cutterName,
            orderId: e.orderId,
            orderName: e.orderName ?? null,
            lineItemId: e.lineItemId,
            sku: e.sku ?? null,
          })),
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

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

  if (intent === "tagsUpdate") {
    const removeTags = formData.getAll("removeTags").map(String);
    const addTags = formData.getAll("addTags").map(String);
    if (removeTags.length > 0) {
      await admin.graphql(
        `#graphql
        mutation TagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
        { variables: { id: orderId, tags: removeTags } },
      );
    }
    if (addTags.length > 0) {
      await admin.graphql(
        `#graphql
        mutation TagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
        { variables: { id: orderId, tags: addTags } },
      );
    }
    return { ok: true };
  }

  return { ok: false };
};

export default function CutListPage() {
  const data = useLoaderData<typeof loader>();
  // All order-tag writes go to the /api/order-tags resource route via fetch, queued
  // PER ORDER. Shopify tag mutations are read-modify-write, so two writes to the same
  // order running at once clobber each other (lost updates) — cutting several items of
  // one order in quick succession would drop tags (picked-line / picked / partially
  // picked). Chaining per order serializes same-order writes (no race) while different
  // orders still run in parallel. (A shared useFetcher cancels in-flight submits; a raw
  // fetch to /app 405s under single fetch — hence a dedicated resource route we await.)
  const orderWriteQueues = useRef<Map<string, Promise<unknown>>>(new Map());
  const enqueueWrite = (form: FormData) => {
    const intent = String(form.get("intent") || "");
    const key =
      intent === "logCut"
        ? "__logcut__"
        : String(form.get("orderId") || "__none__");
    const prev = orderWriteQueues.current.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() =>
        fetch(`/api/order-tags${window.location.search}`, {
          method: "POST",
          body: form,
        }),
      )
      .then(async (resp) => {
        if (!resp.ok) {
          const body = await resp.json().catch(() => null);
          console.error("[order-tags] write rejected", resp.status, body);
        }
      })
      .catch((err) => console.error("[order-tags] write error", err));
    orderWriteQueues.current.set(key, next);
    return next;
  };
  const staffMember = data.staffMember;

  const submitLogCut = (
    events: Array<{
      orderId: string;
      orderName: string;
      lineItemId: string;
      sku: string | null;
    }>,
  ) => {
    if (events.length === 0) return;
    const form = new FormData();
    form.append("intent", "logCut");
    form.append(
      "events",
      JSON.stringify(
        events.map((e) => ({
          cutterId: staffMember?.id ?? null,
          cutterName: staffMember?.name || "Unknown",
          orderId: e.orderId,
          orderName: e.orderName,
          lineItemId: e.lineItemId,
          sku: e.sku ?? null,
        })),
      ),
    );
    enqueueWrite(form);
  };
  const revalidator = useRevalidator();

  const [cutListItems, setCutListItems] = useState<CutListItem[]>(
    data.cutListItems || [],
  );
  useEffect(() => {
    const newCutListItems = data.cutListItems || [];
    const newPickedTodayItems = data.pickedTodayItems || [];

    const protectedOrderIds = getProtectedOrderIds();

    setCutListItems((prev) => {
      if (protectedOrderIds.size === 0) return newCutListItems;
      const prevByLineId = new Map(prev.map((i) => [i.lineItemId, i]));
      const prevByOrderId = new Map<string, CutListItem[]>();
      for (const i of prev) {
        if (!prevByOrderId.has(i.orderId)) prevByOrderId.set(i.orderId, []);
        prevByOrderId.get(i.orderId)!.push(i);
      }
      const seenOrderIds = new Set<string>();
      const merged: CutListItem[] = [];
      for (const item of newCutListItems) {
        seenOrderIds.add(item.orderId);
        if (protectedOrderIds.has(item.orderId)) {
          const local = prevByLineId.get(item.lineItemId);
          merged.push(local ?? item);
        } else {
          merged.push(item);
        }
      }
      for (const orderId of protectedOrderIds) {
        if (!seenOrderIds.has(orderId)) {
          const localItems = prevByOrderId.get(orderId) ?? [];
          merged.push(...localItems);
        }
      }
      return merged;
    });

    setPickedTodayItems((prev) => {
      if (protectedOrderIds.size === 0) return newPickedTodayItems;
      const prevByLineId = new Map(prev.map((i) => [i.lineItemId, i]));
      const prevByOrderId = new Map<string, CutListItem[]>();
      for (const i of prev) {
        if (!prevByOrderId.has(i.orderId)) prevByOrderId.set(i.orderId, []);
        prevByOrderId.get(i.orderId)!.push(i);
      }
      const seenOrderIds = new Set<string>();
      const merged: CutListItem[] = [];
      for (const item of newPickedTodayItems) {
        seenOrderIds.add(item.orderId);
        if (protectedOrderIds.has(item.orderId)) {
          const local = prevByLineId.get(item.lineItemId);
          merged.push(local ?? item);
        } else {
          merged.push(item);
        }
      }
      for (const orderId of protectedOrderIds) {
        if (!seenOrderIds.has(orderId)) {
          const localItems = prevByOrderId.get(orderId) ?? [];
          merged.push(...localItems);
        }
      }
      return merged;
    });

    setLastUpdated(new Date());

    const knownIds = new Set<string>();
    const persistedPicked = new Set<string>();
    for (const item of [...newCutListItems, ...newPickedTodayItems]) {
      knownIds.add(item.lineItemId);
      const numericId = item.lineItemId.split("/").pop();
      if (!numericId) continue;
      if (item.orderTags.some((t) => isPickedLineTagFor(t, numericId))) {
        persistedPicked.add(item.lineItemId);
      }
    }
    const lineItemToOrderId = new Map<string, string>();
    for (const item of [...newCutListItems, ...newPickedTodayItems]) {
      lineItemToOrderId.set(item.lineItemId, item.orderId);
    }

    setPickedItems((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (!knownIds.has(id)) {
          next.add(id);
          continue;
        }
        const oid = lineItemToOrderId.get(id);
        if (oid && protectedOrderIds.has(oid)) {
          next.add(id);
        }
      }
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
      const next = new Set<string>();
      for (const id of prev) {
        if (!knownIds.has(id)) {
          next.add(id);
          continue;
        }
        const oid = lineItemToOrderId.get(id);
        if (oid && protectedOrderIds.has(oid)) {
          next.add(id);
        }
      }
      persistedPrinted.forEach((id) => next.add(id));
      return next;
    });

    const persistedSkipped = new Set<string>();
    for (const item of newCutListItems) {
      const numericId = item.lineItemId.split("/").pop();
      if (!numericId) continue;
      const tag = `skipped:${numericId}`.toLowerCase();
      if (item.orderTags.some((t) => t.toLowerCase() === tag)) {
        persistedSkipped.add(item.lineItemId);
      }
    }
    setSkippedItems((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (!knownIds.has(id)) {
          next.add(id);
          continue;
        }
        const oid = lineItemToOrderId.get(id);
        if (oid && protectedOrderIds.has(oid)) {
          next.add(id);
        }
      }
      persistedSkipped.forEach((id) => next.add(id));
      return next;
    });
  }, [data.cutListItems, data.pickedTodayItems]);

  const [pageInfo] = useState<any>(data.pageInfo || null);
  const [loading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set());
  const [printedLines, setPrintedLines] = useState<Set<string>>(new Set());
  const [skippedItems, setSkippedItems] = useState<Set<string>>(new Set());

  const recentMutationsRef = useRef<Map<string, number>>(new Map());
  const markOrderMutated = (orderId: string) => {
    recentMutationsRef.current.set(orderId, Date.now());
  };
  const getProtectedOrderIds = (): Set<string> => {
    const now = Date.now();
    const protectedIds = new Set<string>();
    for (const [orderId, ts] of recentMutationsRef.current) {
      if (now - ts < 60000) protectedIds.add(orderId);
      else recentMutationsRef.current.delete(orderId);
    }
    return protectedIds;
  };

  type RushAlert = {
    orderId: string;
    orderName: string;
    itemCount: number;
    skus: string[];
  };
  const [newRushAlerts, setNewRushAlerts] = useState<RushAlert[]>([]);
  const seenRushOrderIdsRef = useRef<Set<string> | null>(null);

  type ActionEntry = {
    id: string;
    type: "skip" | "unskip" | "print" | "printBundle";
    description: string;
    lineItemIds: string[];
    orderId: string;
    includeBin?: boolean;
  };
  const [undoStack, setUndoStack] = useState<ActionEntry[]>([]);
  const [redoStack, setRedoStack] = useState<ActionEntry[]>([]);

  const pushAction = (entry: ActionEntry) => {
    setUndoStack((prev) => [...prev.slice(-19), entry]);
    setRedoStack([]);
  };

  const findItemById = (lineItemId: string): CutListItem | undefined => {
    return (
      cutListItems.find((i) => i.lineItemId === lineItemId) ??
      pickedTodayItems.find((i) => i.lineItemId === lineItemId)
    );
  };

  const undoLastAction = () => {
    if (undoStack.length === 0) return;
    const action = undoStack[undoStack.length - 1];
    const items = action.lineItemIds
      .map((id) => findItemById(id))
      .filter((i): i is CutListItem => !!i);

    if (items.length === 0) {
      setUndoStack((prev) => prev.slice(0, -1));
      return;
    }

    switch (action.type) {
      case "skip":
        unskipItem(items[0], { fromHistory: true });
        break;
      case "unskip":
        skipItem(items[0], { fromHistory: true });
        break;
      case "print":
      case "printBundle":
        moveItemsToCutList(items);
        break;
    }

    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, action]);
  };

  const redoLastAction = () => {
    if (redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    const items = action.lineItemIds
      .map((id) => findItemById(id))
      .filter((i): i is CutListItem => !!i);

    if (items.length === 0) {
      setRedoStack((prev) => prev.slice(0, -1));
      return;
    }

    switch (action.type) {
      case "skip":
        skipItem(items[0], { fromHistory: true });
        break;
      case "unskip":
        unskipItem(items[0], { fromHistory: true });
        break;
      case "print":
        openPrint(items[0], action.includeBin ?? true, {
          skipWindow: true,
          fromHistory: true,
        });
        break;
      case "printBundle":
        printSwatchBundle(items, { fromHistory: true });
        break;
    }

    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, action]);
  };
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
    | "localPickup"
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
    () =>
      cutListItems.filter(
        (item) =>
          isRushOrder(item.orderTags) &&
          !hasReadyToShipTag(item) &&
          !pickedItems.has(item.lineItemId),
      ),
    [cutListItems, pickedItems],
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
  const completionModalRef = useRef<any>(null);

  useEffect(() => {
    const el = completionModalRef.current;
    if (!el) return;
    try {
      if (completionMessage) {
        el.showOverlay?.();
      } else {
        el.hideOverlay?.();
      }
    } catch {
      // ignore
    }
  }, [completionMessage]);

  const noteModalRef = useRef<any>(null);

  useEffect(() => {
    const el = noteModalRef.current;
    if (!el) return;
    try {
      if (noteModalContent) {
        el.showOverlay?.();
      } else {
        el.hideOverlay?.();
      }
    } catch {
      // ignore
    }
  }, [noteModalContent]);

  const [moveToCutListConfirm, setMoveToCutListConfirm] = useState<
    CutListItem[] | null
  >(null);
  const moveToCutListModalRef = useRef<any>(null);

  useEffect(() => {
    const el = moveToCutListModalRef.current;
    if (!el) return;
    try {
      if (moveToCutListConfirm) {
        el.showOverlay?.();
      } else {
        el.hideOverlay?.();
      }
    } catch {
      // ignore
    }
  }, [moveToCutListConfirm]);

  const [skuAnchorTimes, setSkuAnchorTimes] = useState<Record<string, number>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const stored = window.localStorage.getItem("skuAnchorTimes");
        if (!stored) return {};
        const parsed = JSON.parse(stored);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
      } catch {
        return {};
      }
    },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "skuAnchorTimes",
        JSON.stringify(skuAnchorTimes),
      );
    } catch {
      // ignore
    }
  }, [skuAnchorTimes]);

  useEffect(() => {
    const currentRush = cutListItems.filter(
      (item) =>
        isRushOrder(item.orderTags) &&
        !hasReadyToShipTag(item) &&
        !pickedItems.has(item.lineItemId),
    );
    const currentRushOrderIds = new Set(currentRush.map((i) => i.orderId));

    if (seenRushOrderIdsRef.current === null) {
      seenRushOrderIdsRef.current = currentRushOrderIds;
      return;
    }

    const seen = seenRushOrderIdsRef.current;
    const newOrders = currentRush.filter((i) => !seen.has(i.orderId));
    if (newOrders.length === 0) return;

    const grouped = new Map<string, CutListItem[]>();
    for (const item of newOrders) {
      if (!grouped.has(item.orderId)) grouped.set(item.orderId, []);
      grouped.get(item.orderId)!.push(item);
    }

    const newAlerts: RushAlert[] = [];
    grouped.forEach((items, orderId) => {
      const skus = Array.from(
        new Set(items.map((i) => i.sku).filter((s): s is string => !!s)),
      );
      newAlerts.push({
        orderId,
        orderName: items[0].orderName,
        itemCount: items.length,
        skus,
      });
    });

    setNewRushAlerts((prev) => {
      const existing = new Set(prev.map((a) => a.orderId));
      return [...prev, ...newAlerts.filter((a) => !existing.has(a.orderId))];
    });

    const updatedSeen = new Set(seen);
    newOrders.forEach((i) => updatedSeen.add(i.orderId));
    seenRushOrderIdsRef.current = updatedSeen;
  }, [cutListItems, pickedItems]);

  useEffect(() => {
    if (newRushAlerts.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const dismissedNumericIds = new Set<string>();
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const orderIdNum = (entry.target as HTMLElement).getAttribute(
              "data-rush-order-id",
            );
            if (orderIdNum) dismissedNumericIds.add(orderIdNum);
          }
        });
        if (dismissedNumericIds.size > 0) {
          setNewRushAlerts((prev) =>
            prev.filter(
              (a) => !dismissedNumericIds.has(a.orderId.split("/").pop() ?? ""),
            ),
          );
        }
      },
      { threshold: 0 },
    );

    const attach = () => {
      const activeOrderIds = new Set(
        newRushAlerts.map((a) => a.orderId.split("/").pop()).filter(Boolean),
      );
      activeOrderIds.forEach((orderIdNum) => {
        const els = document.querySelectorAll(
          `[data-rush-order-id="${orderIdNum}"]`,
        );
        els.forEach((el) => observer.observe(el));
      });
    };

    attach();
    const raf = requestAnimationFrame(attach);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [newRushAlerts]);

  useEffect(() => {
    if (!activeLineId) return;
    const activeItem = cutListItems.find(
      (i) => i.lineItemId === activeLineId,
    );
    if (!activeItem) return;
    if (!activeItem.sku) return;
    if (activeItem.sku === VIRTUAL_SKU) return;
    if (isSwatch(activeItem)) return;

    setSkuAnchorTimes((prev) => {
      if (prev[activeItem.sku] != null) return prev;
      const sameSkuItems = cutListItems.filter(
        (i) => i.sku === activeItem.sku,
      );
      if (sameSkuItems.length === 0) return prev;
      const earliest = Math.min(
        ...sameSkuItems.map((i) => new Date(i.orderCreatedAt).getTime()),
      );
      return { ...prev, [activeItem.sku]: earliest };
    });
  }, [activeLineId, cutListItems]);

  useEffect(() => {
    setSkuAnchorTimes((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const sku of Object.keys(prev)) {
        const hasItems = cutListItems.some(
          (item) =>
            item.sku === sku &&
            !hasReadyToShipTag(item) &&
            !pickedItems.has(item.lineItemId),
        );
        if (hasItems) {
          next[sku] = prev[sku];
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cutListItems, pickedItems]);

  useEffect(() => {
    if (!activeLineId) return;
    const t = setTimeout(() => {
      scanInputRef.current?.focus?.();
    }, 50);
    return () => clearTimeout(t);
  }, [activeLineId]);

  useEffect(() => {
    if (!activeLineId) return;
    const activeItem = cutListItems.find(
      (i) => i.lineItemId === activeLineId,
    );
    if (!activeItem) return;
    if (!activeItem.sku) return;
    if (activeItem.sku === VIRTUAL_SKU) return;
    if (isSwatch(activeItem)) return;
    const activeSku = activeItem.sku;

    setReadyToPrint((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        const other = cutListItems.find((i) => i.lineItemId === id);
        if (!other || other.sku === activeSku) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeLineId, cutListItems]);

  // Auto-open the order note when a line is activated, so the cutter sees any
  // special instructions BEFORE cutting. Shown once per order (marked acknowledged),
  // so it won't re-pop; the NOTE badge still reopens it on demand.
  useEffect(() => {
    if (!activeLineId) return;
    const activeItem =
      cutListItems.find((i) => i.lineItemId === activeLineId) ??
      pickedTodayItems.find((i) => i.lineItemId === activeLineId);
    if (!activeItem) return;
    if (!activeItem.orderNote) return;
    if (acknowledgedNotes.has(activeItem.orderId)) return;
    setNoteModalContent({
      orderName: activeItem.orderName,
      note: activeItem.orderNote,
    });
    setAcknowledgedNotes((prev) => new Set(prev).add(activeItem.orderId));
  }, [activeLineId, cutListItems, pickedTodayItems, acknowledgedNotes]);

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

  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const showProductCountModalRef = useRef(showProductCountModal);
  showProductCountModalRef.current = showProductCountModal;
  const previewImageRef = useRef(previewImage);
  previewImageRef.current = previewImage;

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      const activeEl = document.activeElement as
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLElement
        | null;
      const isInputElement =
        activeEl?.tagName === "INPUT" || activeEl?.tagName === "TEXTAREA";
      const hasText =
        isInputElement &&
        ((activeEl as HTMLInputElement).value?.length ?? 0) > 0;
      const isContentEditable =
        activeEl?.getAttribute("contenteditable") === "true";
      const isTyping = hasText || isContentEditable;

      console.log("[refresh] tick", {
        activeTag: activeEl?.tagName,
        activeValue: isInputElement
          ? (activeEl as HTMLInputElement).value?.slice(0, 20)
          : undefined,
        isTyping,
        state: revalidatorRef.current.state,
        modal: showProductCountModalRef.current,
        preview: !!previewImageRef.current,
      });

      if (isTyping) return;
      if (revalidatorRef.current.state !== "idle") return;
      if (showProductCountModalRef.current || !!previewImageRef.current) return;

      console.log("[refresh] calling revalidate");
      revalidatorRef.current.revalidate();
    }, 30000);

    return () => clearInterval(refreshInterval);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        revalidator.revalidate();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [revalidator]);

  useEffect(() => {
    setLastUpdated(new Date());
  }, [data.cutListItems, data.pickedTodayItems]);

  function submitTagsAdd(orderId: string, tags: string[]) {
    markOrderMutated(orderId);
    const form = new FormData();
    form.append("intent", "tagsAdd");
    form.append("orderId", orderId);
    tags.forEach((tag) => form.append("tags", tag));
    enqueueWrite(form);
  }

  function submitTagsRemove(orderId: string, tags: string[]) {
    markOrderMutated(orderId);
    const form = new FormData();
    form.append("intent", "tagsRemove");
    form.append("orderId", orderId);
    tags.forEach((tag) => form.append("tags", tag));
    enqueueWrite(form);
  }

  function submitTagsUpdate(
    orderId: string,
    removeTags: string[],
    addTags: string[],
  ) {
    if (removeTags.length === 0 && addTags.length === 0) return;
    markOrderMutated(orderId);
    const form = new FormData();
    form.append("intent", "tagsUpdate");
    form.append("orderId", orderId);
    removeTags.forEach((tag) => form.append("removeTags", tag));
    addTags.forEach((tag) => form.append("addTags", tag));
    enqueueWrite(form);
  }

  const effectiveCreatedAt = (item: CutListItem): number => {
    if (item.sku && skuAnchorTimes[item.sku] != null) {
      return skuAnchorTimes[item.sku];
    }
    return new Date(item.orderCreatedAt).getTime();
  };

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
        const latestTime = Math.max(...items.map((i) => effectiveCreatedAt(i)));
        return { customerId, items, latestTime };
      },
    );

    customerGroupsWithLatest.sort((a, b) => a.latestTime - b.latestTime);

    const sortedItems: CutListItem[] = [];
    for (const group of customerGroupsWithLatest) {
      group.items.sort((a, b) => effectiveCreatedAt(a) - effectiveCreatedAt(b));
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
      skuGroup.sort((a, b) => effectiveCreatedAt(a) - effectiveCreatedAt(b));
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
    const rushSkus = new Set(
      items
        .filter((item) => rushOrderIds.has(item.orderId) && item.sku)
        .map((item) => item.sku),
    );

    const topItems = items.filter(
      (item) => rushOrderIds.has(item.orderId) || rushSkus.has(item.sku),
    );
    const remainingItems = items.filter(
      (item) => !rushOrderIds.has(item.orderId) && !rushSkus.has(item.sku),
    );

    const topSkuGroups = new Map<string, CutListItem[]>();
    for (const item of topItems) {
      const key = item.sku || `__no_sku__${item.lineItemId}`;
      if (!topSkuGroups.has(key)) topSkuGroups.set(key, []);
      topSkuGroups.get(key)!.push(item);
    }

    const sortedTopGroups = Array.from(topSkuGroups.values()).map((group) => {
      group.sort((a, b) => effectiveCreatedAt(a) - effectiveCreatedAt(b));
      return group;
    });
    sortedTopGroups.sort(
      (a, b) => effectiveCreatedAt(a[0]) - effectiveCreatedAt(b[0]),
    );

    const sortedRemaining = applyCustomerBatchingSort(remainingItems);
    return [...sortedTopGroups.flat(), ...sortedRemaining];
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
          <span style={{ fontSize: "1.25em", fontWeight: 700 }}>
            {(quantity / 4).toFixed(2)} yds
          </span>
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

  function formatEasternTagTimestamp(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).formatToParts(date);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
  }

  function isRushOrder(orderTags: string[]): boolean {
    return orderTags.some((tag) => tag.toLowerCase() === "rush");
  }

  function hasReadyToShipTag(item: CutListItem): boolean {
    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return false;
    const tag = `ready-to-ship:${numericId}`.toLowerCase();
    return item.orderTags.some((t) => t.toLowerCase() === tag);
  }

  function hasSkippedTag(item: CutListItem): boolean {
    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return false;
    const tag = `skipped:${numericId}`.toLowerCase();
    return item.orderTags.some((t) => t.toLowerCase() === tag);
  }

  function skippedTagFor(item: CutListItem): string | null {
    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return null;
    return `skipped:${numericId}`;
  }

  function isSwatch(item: CutListItem): boolean {
    if (item.variantTitle?.toLowerCase().includes("swatch sample")) return true;
    if (item.sku.toLowerCase().includes("swatch")) return true;
    if (item.fabricLength?.toLowerCase().includes("swatch sample")) return true;
    return false;
  }

  function isSilkSwatchNeedingSubstitute(item: CutListItem): boolean {
    if (!isSwatch(item)) return false;
    const title = item.productTitle?.toLowerCase() ?? "";
    if (!title.includes("silk")) return false;
    if (title.includes("crepe de chine")) return false;
    if ((item.colorCode ?? "").trim() === "101") return false;
    if (!item.colorCode || !item.productId) return false;
    return true;
  }

  type SubstitutePayload = {
    productTitle: string;
    variantTitle: string | null;
    sku: string;
    barcode: string | null;
    colorCode: string | null;
  };

  type SubstituteResult = {
    productId: string;
    colorCode: string;
    substituteA: SubstitutePayload | null;
    substituteB: SubstitutePayload | null;
  };

  async function resolveSilkSubstitutes(
    items: CutListItem[],
  ): Promise<Map<string, SubstituteResult>> {
    console.log(
      "[silk] resolveSilkSubstitutes called with items",
      items.map((i) => ({
        lineItemId: i.lineItemId,
        productTitle: i.productTitle,
        variantTitle: i.variantTitle,
        sku: i.sku,
        productId: i.productId,
        colorCode: i.colorCode,
        isSwatch: isSwatch(i),
        needsSubstitute: isSilkSwatchNeedingSubstitute(i),
      })),
    );
    const needs = items.filter(isSilkSwatchNeedingSubstitute);
    console.log("[silk] items needing substitute", needs.length);
    if (needs.length === 0) return new Map();

    const seen = new Set<string>();
    const inputs: Array<{ productId: string; colorCode: string }> = [];
    for (const it of needs) {
      const key = `${it.productId}::${it.colorCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push({ productId: it.productId, colorCode: it.colorCode! });
    }

    const form = new FormData();
    form.append("items", JSON.stringify(inputs));

    const resp = await fetch(
      `/api/silk-substitutes${window.location.search}`,
      {
        method: "POST",
        body: form,
      },
    );
    const json: any = await resp.json().catch(() => null);
    const results: SubstituteResult[] = json?.results ?? [];
    console.log("[silk] resolver inputs", inputs);
    console.log("[silk] resolver results", results);
    console.log("[silk] debug", json?.debug);

    const map = new Map<string, SubstituteResult>();
    for (const r of results) {
      map.set(`${r.productId}::${r.colorCode}`, r);
    }
    return map;
  }

  function expandSilkSwatchForPrint(
    item: CutListItem,
    substitutes: Map<string, SubstituteResult>,
  ) {
    const baseItem = {
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
      sku: item.sku,
      barcode: item.barcode,
      colorCode: item.colorCode || null,
    };

    const itemIsSwatch = isSwatch(item);
    const repeatCount = itemIsSwatch ? Math.max(1, item.quantity) : 1;

    const repeatPerUnit = (labels: typeof baseItem[]) => {
      if (!itemIsSwatch) return labels;
      const out: typeof baseItem[] = [];
      for (const label of labels) {
        for (let i = 0; i < repeatCount; i++) {
          out.push({ ...label, quantity: 1 });
        }
      }
      return out;
    };

    if (!isSilkSwatchNeedingSubstitute(item)) return repeatPerUnit([baseItem]);

    const key = `${item.productId}::${item.colorCode}`;
    const res = substitutes.get(key);
    if (!res) return repeatPerUnit([baseItem]);

    const labels: typeof baseItem[] = [];
    if (res.substituteA) {
      labels.push({
        productTitle: res.substituteA.productTitle,
        variantTitle: res.substituteA.variantTitle,
        quantity: item.quantity,
        sku: res.substituteA.sku,
        barcode: res.substituteA.barcode,
        colorCode: res.substituteA.colorCode,
      });
    }
    if (res.substituteB) {
      labels.push({
        productTitle: res.substituteB.productTitle,
        variantTitle: res.substituteB.variantTitle,
        quantity: item.quantity,
        sku: res.substituteB.sku,
        barcode: res.substituteB.barcode,
        colorCode: res.substituteB.colorCode,
      });
    }
    return repeatPerUnit(labels.length > 0 ? labels : [baseItem]);
  }

  function isItemCut(item: CutListItem): boolean {
    const isOrderFullyPicked = item.orderTags.some(
      (t) => t.toLowerCase() === "picked",
    );
    if (isOrderFullyPicked) return true;

    const numericId = item.lineItemId.split("/").pop();
    if (!numericId) return false;
    return item.orderTags.some((t) => isPickedLineTagFor(t, numericId));
  }

  const skipItem = (item: CutListItem, options?: { fromHistory?: boolean }) => {
    const tag = skippedTagFor(item);
    if (!tag) return;
    submitTagsUpdate(item.orderId, [], [tag]);
    setCutListItems((prev) =>
      prev.map((i) =>
        i.lineItemId === item.lineItemId
          ? { ...i, orderTags: Array.from(new Set([...i.orderTags, tag])) }
          : i,
      ),
    );
    setSkippedItems((prev) => new Set(prev).add(item.lineItemId));

    if (activeLineId === item.lineItemId) {
      const itemsNow = getFilteredItems();
      const currentIndex = itemsNow.findIndex(
        (i) => i.lineItemId === item.lineItemId,
      );
      const nextItem = itemsNow[currentIndex + 1];
      if (nextItem) {
        setActiveLineId(nextItem.lineItemId);
      }
    }

    if (!options?.fromHistory) {
      pushAction({
        id: `${Date.now()}-${item.lineItemId}`,
        type: "skip",
        description: `Skip — ${item.orderName} ${item.sku || ""}`.trim(),
        lineItemIds: [item.lineItemId],
        orderId: item.orderId,
      });
    }
  };

  const unskipItem = (item: CutListItem, options?: { fromHistory?: boolean }) => {
    const tag = skippedTagFor(item);
    if (!tag) return;
    const tagLower = tag.toLowerCase();
    submitTagsUpdate(item.orderId, [tag], []);
    setCutListItems((prev) =>
      prev.map((i) =>
        i.lineItemId === item.lineItemId
          ? {
              ...i,
              orderTags: i.orderTags.filter(
                (t) => t.toLowerCase() !== tagLower,
              ),
            }
          : i,
      ),
    );
    setSkippedItems((prev) => {
      const next = new Set(prev);
      next.delete(item.lineItemId);
      return next;
    });

    if (!options?.fromHistory) {
      pushAction({
        id: `${Date.now()}-${item.lineItemId}`,
        type: "unskip",
        description: `Unskip — ${item.orderName} ${item.sku || ""}`.trim(),
        lineItemIds: [item.lineItemId],
        orderId: item.orderId,
      });
    }
  };

  const getPickedByName = (item: CutListItem): string => {
    const numericId = item.lineItemId.split("/").pop();
    if (numericId) {
      const prefix = `cut-by:${numericId}_`.toLowerCase();
      for (const tag of item.orderTags) {
        if (tag.toLowerCase().startsWith(prefix)) {
          return tag.substring(prefix.length);
        }
      }
    }
    const excludeTags = ["picked", "partially picked", "printed", "rush"];
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}/;
    for (const tag of item.orderTags) {
      const lower = tag.toLowerCase();
      if (lower.startsWith("cut-by:") || isAnyPickedLineTag(tag)) continue;
      if (!excludeTags.includes(lower) && !isoDatePattern.test(tag)) {
        return tag;
      }
    }
    return employeeName;
  };

  const cutListItemsVisible = cutListItems.filter(
    (item) =>
      !hasReadyToShipTag(item) && !pickedItems.has(item.lineItemId),
  );

  const getFilteredItems = (): CutListItem[] => {
    if (currentFilter === "pickedToday") {
      const items = pickedTodayItems.filter((item) => {
        if (!isItemCut(item)) return false;
        if (item.quantity === 0) return false;
        const orderFullyPicked = item.orderTags.some(
          (t) => t.toLowerCase() === "picked",
        );
        if (orderFullyPicked) return false;
        return true;
      });
      const orderGroups = new Map<string, CutListItem[]>();
      for (const item of items) {
        if (!orderGroups.has(item.orderId)) {
          orderGroups.set(item.orderId, []);
        }
        orderGroups.get(item.orderId)!.push(item);
      }
      const latestCutTime = (group: CutListItem[]): number => {
        let latest = new Date(group[0].orderCreatedAt).getTime();
        for (const tag of group[0].orderTags) {
          const t = new Date(tag).getTime();
          if (!isNaN(t)) latest = Math.max(latest, t);
        }
        return latest;
      };
      const sortedGroups = Array.from(orderGroups.values()).sort(
        (a, b) => latestCutTime(b) - latestCutTime(a),
      );
      return sortedGroups.flat();
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

    if (currentFilter === "localPickup") {
      const localPickupItems = cutListItemsVisible.filter((item) =>
        item.orderTags.some((t) => t.toLowerCase() === "local pickup"),
      );
      return applyRushFirstSort(localPickupItems);
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
          item.quantity > 0 &&
          item.displayFulfillmentStatus !== "READY_FOR_PICKUP",
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

    const workingItems = cutListItemsVisible.filter(
      (item) => !skippedItems.has(item.lineItemId),
    );
    const heldItems = cutListItemsVisible.filter((item) =>
      skippedItems.has(item.lineItemId),
    );

    const applySkippedSort = (items: CutListItem[]): CutListItem[] => {
      const skuGroups = new Map<string, CutListItem[]>();
      for (const item of items) {
        const key = item.sku || `__no_sku__${item.lineItemId}`;
        if (!skuGroups.has(key)) skuGroups.set(key, []);
        skuGroups.get(key)!.push(item);
      }
      const sortedGroups = Array.from(skuGroups.values()).map((group) => {
        group.sort(
          (a, b) =>
            new Date(a.orderCreatedAt).getTime() -
            new Date(b.orderCreatedAt).getTime(),
        );
        return group;
      });
      sortedGroups.sort(
        (a, b) =>
          new Date(a[0].orderCreatedAt).getTime() -
          new Date(b[0].orderCreatedAt).getTime(),
      );
      return sortedGroups.flat();
    };

    const sortedHeld = applySkippedSort(heldItems);
    const allItems = applyRushFirstSort(workingItems);

    const buildStrictOrderMap = () => {
      const fullOrderMap = new Map<string, CutListItem[]>();
      for (const item of cutListItems) {
        if (item.sku === VIRTUAL_SKU) continue;
        if (hasReadyToShipTag(item)) continue;
        if (!fullOrderMap.has(item.orderId)) fullOrderMap.set(item.orderId, []);
        fullOrderMap.get(item.orderId)!.push(item);
      }
      return fullOrderMap;
    };

    if (currentFilter === "rollEnds") {
      const fullOrderMap = buildStrictOrderMap();
      const rollEndOrders = new Set<string>();
      fullOrderMap.forEach((items, orderId) => {
        const allAreYardPiece = items.every((item) =>
          item.variantTitle?.includes("Yard Piece"),
        );
        const hasUncut = items.some(
          (item) => !pickedItems.has(item.lineItemId),
        );
        if (allAreYardPiece && hasUncut) rollEndOrders.add(orderId);
      });
      return allItems.filter((item) => rollEndOrders.has(item.orderId));
    }

    if (currentFilter === "swatches") {
      const fullOrderMap = buildStrictOrderMap();
      const swatchOrders = new Set<string>();
      fullOrderMap.forEach((items, orderId) => {
        const allAreSwatches = items.every((item) => isSwatch(item));
        const hasUncut = items.some(
          (item) => !pickedItems.has(item.lineItemId),
        );
        if (allAreSwatches && hasUncut) swatchOrders.add(orderId);
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

    return [...sortedHeld, ...allItems];
  };

  const getSummaryStats = () => {
    const filteredCutListItems = cutListItems.filter(
      (item) => item.sku !== VIRTUAL_SKU && !hasReadyToShipTag(item),
    );
    const uniqueOrders = new Set(filteredCutListItems.map((i) => i.orderId));
    const uncutItems = filteredCutListItems.filter(
      (item) => !pickedItems.has(item.lineItemId),
    );
    const totalCuts = uncutItems.reduce(
      (sum, item) => sum + Math.max(1, item.quantity),
      0,
    );

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
      const allAreSwatches = items.every((item) => isSwatch(item));
      const hasUncut = items.some(
        (item) => !pickedItems.has(item.lineItemId),
      );

      if (allAreYardPiece && hasUncut) rollEndsOnlyCount++;
      if (allAreSwatches && hasUncut) swatchesOnlyCount++;
    });

    const cutLogItems = pickedTodayItems.filter((item) => {
      if (item.sku === VIRTUAL_SKU) return false;
      if (!isItemCut(item)) return false;
      if (item.quantity === 0) return false;
      const orderFullyPicked = item.orderTags.some(
        (t) => t.toLowerCase() === "picked",
      );
      if (orderFullyPicked) return false;
      return true;
    });
    const uniqueCutLogOrders = new Set(
      cutLogItems.map((item) => item.orderId),
    );

    const readyToShipOrders = new Set(
      pickedTodayItems
        .filter((item) => {
          if (item.sku === VIRTUAL_SKU) return false;
          if (item.hasHold) return false;
          if (item.quantity === 0) return false;
          if (item.displayFulfillmentStatus === "READY_FOR_PICKUP") return false;
          const orderFullyPicked = item.orderTags.some(
            (t) => t.toLowerCase() === "picked",
          );
          return orderFullyPicked || hasReadyToShipTag(item);
        })
        .map((item) => item.orderId),
    );

    const totalSwatchesCount = filteredCutListItems
      .filter(
        (item) => isSwatch(item) && !pickedItems.has(item.lineItemId),
      )
      .reduce((sum, item) => sum + Math.max(1, item.quantity), 0);

    const localPickupOrders = new Set(
      filteredCutListItems
        .filter((item) =>
          item.orderTags.some((t) => t.toLowerCase() === "local pickup"),
        )
        .map((item) => item.orderId),
    );

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
      localPickup: localPickupOrders.size,
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
    // Note: the order-note modal opens on line activation (see the activeLineId
    // effect), not here — so the cutter sees it before scanning, only once.
  };

  const upsertOrderInPickedToday = (
    orderId: string,
    tagsToAdd: string[],
    tagsToRemoveFromOrder: string[] = [],
  ) => {
    setPickedTodayItems((prev) => {
      const applyTagChanges = (existing: string[]) =>
        Array.from(
          new Set([
            ...existing.filter((t) => !tagsToRemoveFromOrder.includes(t)),
            ...tagsToAdd,
          ]),
        );

      const exists = prev.some((i) => i.orderId === orderId);
      if (exists) {
        return prev.map((i) =>
          i.orderId === orderId
            ? { ...i, orderTags: applyTagChanges(i.orderTags) }
            : i,
        );
      }
      const newOrderItems = cutListItems
        .filter((i) => i.orderId === orderId)
        .map((i) => ({ ...i, orderTags: applyTagChanges(i.orderTags) }));
      return [...prev, ...newOrderItems];
    });
  };

  const openPrint = async (
    item: CutListItem,
    includeBin: boolean,
    options?: { skipWindow?: boolean; skipCut?: boolean; fromHistory?: boolean },
  ) => {
    const skipWindow = options?.skipWindow ?? false;
    const skipCut = options?.skipCut ?? false;
    const fromHistory = options?.fromHistory ?? false;
    const includeCut = !skipCut;

    if (!fromHistory && !skipCut) {
      pushAction({
        id: `${Date.now()}-${item.lineItemId}`,
        type: "print",
        description: `Print — ${item.orderName} ${item.sku || ""}`.trim(),
        lineItemIds: [item.lineItemId],
        orderId: item.orderId,
        includeBin,
      });
    }

    // Record the cut synchronously BEFORE any await. A React Router fetcher
    // submission must fire within the click handler's synchronous run; calling
    // it after `await resolveSilkSubstitutes` drops the write so the cut never
    // persists and the line returns to the list. Substitutes are only needed for
    // the printed labels, so they are resolved after the cut is recorded.
    const orderItems = cutListItems.filter((i) => i.orderId === item.orderId);
    const pickedCount = orderItems.filter(
      (i) => pickedItems.has(i.lineItemId) || i.lineItemId === item.lineItemId,
    ).length;
    const totalCount = orderItems.filter((i) => i.sku !== VIRTUAL_SKU).length;
    const timestamp = formatEasternTagTimestamp();
    const numericLineId = item.lineItemId.split("/").pop() || item.lineItemId;
    const lineItemTag = pickedLineTag(numericLineId, item.sku);
    // Keep cut-by under Shopify's 40-char tag limit: "cut-by:" + 14-digit id + "_"
    // already uses 22 chars, leaving ~18 for the name.
    const cutByName = (employeeName || "Unknown")
      .replace(/,/g, "")
      .trim()
      .slice(0, 16);
    const cutByTag = `cut-by:${numericLineId}_${cutByName}`;
    const orderHadPrintedTag = item.orderTags.some(
      (t) => t.toLowerCase() === "printed",
    );
    const printedTag = includeBin && !orderHadPrintedTag ? ["printed"] : [];

    if (pickedCount === totalCount) {
      const tagsToAdd = ["picked", timestamp, lineItemTag, cutByTag, ...printedTag];
      submitTagsUpdate(item.orderId, ["partially picked"], tagsToAdd);

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
      upsertOrderInPickedToday(item.orderId, tagsToAdd, ["partially picked"]);

      setCompletionMessage(
        `Order ${item.orderName} is complete. All items cut.`,
      );
    } else if (pickedCount === 1) {
      const tagsToAdd = [
        "partially picked",
        timestamp,
        lineItemTag,
        cutByTag,
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
      upsertOrderInPickedToday(item.orderId, tagsToAdd);
    } else {
      const tagsToAdd = [lineItemTag, cutByTag, ...printedTag];
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
      upsertOrderInPickedToday(item.orderId, tagsToAdd);
    }

    setPickedItems((prev) => new Set(prev).add(item.lineItemId));
    setPrintedLines((prev) => new Set(prev).add(item.lineItemId));
    setReadyToPrint((prev) => {
      const next = new Set(prev);
      next.delete(item.lineItemId);
      return next;
    });

    submitLogCut([
      {
        orderId: item.orderId,
        orderName: item.orderName,
        lineItemId: item.lineItemId,
        sku: item.sku || null,
      },
    ]);

    const substitutes =
      includeCut && isSilkSwatchNeedingSubstitute(item)
        ? await resolveSilkSubstitutes([item])
        : new Map<string, SubstituteResult>();
    const expanded = expandSilkSwatchForPrint(item, substitutes);
    const itemsParam = encodeURIComponent(JSON.stringify(expanded));
    const url = `/print-label-both?orderName=${encodeURIComponent(item.orderName)}&items=${itemsParam}&includeBin=${includeBin}&includeCut=${includeCut}`;

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

  const reprintLabel = async (item: CutListItem, mode: "bin" | "cut") => {
    const includeCut = mode === "cut";
    const substitutes =
      includeCut && isSilkSwatchNeedingSubstitute(item)
        ? await resolveSilkSubstitutes([item])
        : new Map<string, SubstituteResult>();
    const expanded = expandSilkSwatchForPrint(item, substitutes);
    const itemsParam = encodeURIComponent(JSON.stringify(expanded));
    const url = `/print-label-both?orderName=${encodeURIComponent(item.orderName)}&items=${itemsParam}&includeBin=${mode === "bin" ? "true" : "false"}&includeCut=${includeCut ? "true" : "false"}`;
    window.open(url, "_blank");
  };

  const moveItemsToCutList = (items: CutListItem[]) => {
    if (items.length === 0) return;
    const orderId = items[0].orderId;
    const orderTags = items[0].orderTags;
    const movingIds = new Set(items.map((i) => i.lineItemId));

    const tagsToRemove: string[] = [];
    for (const it of items) {
      const numericId = it.lineItemId.split("/").pop() || it.lineItemId;
      const readyToShipExact = `ready-to-ship:${numericId}`.toLowerCase();
      const cutByPrefix = `cut-by:${numericId}_`.toLowerCase();
      const skippedExact = `skipped:${numericId}`.toLowerCase();
      for (const tag of orderTags) {
        const lower = tag.toLowerCase();
        if (isPickedLineTagFor(tag, numericId)) {
          tagsToRemove.push(tag);
        }
        if (lower === readyToShipExact) {
          tagsToRemove.push(tag);
        }
        if (lower.startsWith(cutByPrefix)) {
          tagsToRemove.push(tag);
        }
        if (lower === skippedExact) {
          tagsToRemove.push(tag);
        }
      }
    }

    const allOrderItems = new Map<string, CutListItem>();
    for (const i of [...cutListItems, ...pickedTodayItems]) {
      if (i.orderId === orderId) {
        allOrderItems.set(i.lineItemId, i);
      }
    }
    const remainingPickedCount = Array.from(allOrderItems.values())
      .filter((i) => !movingIds.has(i.lineItemId))
      .filter((i) => pickedItems.has(i.lineItemId)).length;

    const tagsToAdd: string[] = [];
    if (remainingPickedCount === 0) {
      if (orderTags.some((t) => t.toLowerCase() === "partially picked")) {
        tagsToRemove.push("partially picked");
      }
      if (orderTags.some((t) => t.toLowerCase() === "picked")) {
        tagsToRemove.push("picked");
      }
      if (orderTags.some((t) => t.toLowerCase() === "printed")) {
        tagsToRemove.push("printed");
      }
    } else if (orderTags.some((t) => t.toLowerCase() === "picked")) {
      tagsToRemove.push("picked");
      if (!orderTags.some((t) => t.toLowerCase() === "partially picked")) {
        tagsToAdd.push("partially picked");
      }
    }

    const dedupedRemove = Array.from(new Set(tagsToRemove));
    submitTagsUpdate(orderId, dedupedRemove, tagsToAdd);

    setPickedItems((prev) => {
      const next = new Set(prev);
      items.forEach((it) => next.delete(it.lineItemId));
      return next;
    });
    setPrintedLines((prev) => {
      const next = new Set(prev);
      items.forEach((it) => next.delete(it.lineItemId));
      return next;
    });
    setReadyToPrint((prev) => {
      const next = new Set(prev);
      items.forEach((it) => next.delete(it.lineItemId));
      return next;
    });

    const removeSet = new Set(dedupedRemove);
    setCutListItems((prev) =>
      prev.map((i) =>
        i.orderId === orderId
          ? {
              ...i,
              orderTags: Array.from(
                new Set([
                  ...i.orderTags.filter((t) => !removeSet.has(t)),
                  ...tagsToAdd,
                ]),
              ),
            }
          : i,
      ),
    );
    setPickedTodayItems((prev) =>
      prev.map((i) =>
        i.orderId === orderId
          ? {
              ...i,
              orderTags: Array.from(
                new Set([
                  ...i.orderTags.filter((t) => !removeSet.has(t)),
                  ...tagsToAdd,
                ]),
              ),
            }
          : i,
      ),
    );
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

  const reprintSwatchBundle = async (swatches: CutListItem[]) => {
    if (swatches.length === 0) return;
    const orderName = swatches[0].orderName;
    const substitutes = await resolveSilkSubstitutes(swatches);
    const expanded = swatches.flatMap((s) =>
      expandSilkSwatchForPrint(s, substitutes),
    );
    const itemsParam = encodeURIComponent(JSON.stringify(expanded));
    window.open(
      `/print-label-both?orderName=${encodeURIComponent(orderName)}&items=${itemsParam}&includeBin=true&includeCut=true`,
      "_blank",
    );
  };

  const printSwatchBundle = async (
    swatches: CutListItem[],
    options?: { fromHistory?: boolean },
  ) => {
    if (swatches.length === 0) return;
    const first = swatches[0];
    const orderId = first.orderId;
    const orderName = first.orderName;

    if (!options?.fromHistory) {
      pushAction({
        id: `${Date.now()}-${first.lineItemId}`,
        type: "printBundle",
        description: `Print Bundle — ${orderName} (${swatches.length} swatches)`,
        lineItemIds: swatches.map((s) => s.lineItemId),
        orderId,
        includeBin: true,
      });
    }

    // Record the cut synchronously BEFORE any await (see note in openPrint) —
    // substitutes/print happen afterward.
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
    const timestamp = formatEasternTagTimestamp();
    const swatchLineTags = swatches.map((s) => {
      const numericId = s.lineItemId.split("/").pop() || s.lineItemId;
      return pickedLineTag(numericId, s.sku);
    });
    // Keep cut-by under Shopify's 40-char tag limit: "cut-by:" + 14-digit id + "_"
    // already uses 22 chars, leaving ~18 for the name.
    const cutByName = (employeeName || "Unknown")
      .replace(/,/g, "")
      .trim()
      .slice(0, 16);
    const cutByTags = swatches.map((s) => {
      const numericId = s.lineItemId.split("/").pop() || s.lineItemId;
      return `cut-by:${numericId}_${cutByName}`;
    });
    const hadPartialTag = first.orderTags.some(
      (t) => t.toLowerCase() === "partially picked",
    );

    if (pickedCount === totalCount) {
      const tagsToAdd = ["picked", timestamp, ...swatchLineTags, ...cutByTags];
      submitTagsUpdate(orderId, ["partially picked"], tagsToAdd);
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
      upsertOrderInPickedToday(orderId, tagsToAdd, ["partially picked"]);
      setCompletionMessage(
        `Order ${orderName} is complete. All items cut.`,
      );
    } else if (!hadPartialTag) {
      const tagsToAdd = [
        "partially picked",
        timestamp,
        ...swatchLineTags,
        ...cutByTags,
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
      upsertOrderInPickedToday(orderId, tagsToAdd);
    } else {
      const tagsToAdd = [...swatchLineTags, ...cutByTags];
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
      upsertOrderInPickedToday(orderId, tagsToAdd);
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

    submitLogCut(
      swatches.map((s) => ({
        orderId: s.orderId,
        orderName: s.orderName,
        lineItemId: s.lineItemId,
        sku: s.sku || null,
      })),
    );

    const substitutes = await resolveSilkSubstitutes(swatches);
    const expanded = swatches.flatMap((s) =>
      expandSilkSwatchForPrint(s, substitutes),
    );
    const itemsParam = encodeURIComponent(JSON.stringify(expanded));
    const url = `/print-label-both?orderName=${encodeURIComponent(orderName)}&items=${itemsParam}&includeBin=true&includeCut=true`;
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
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "#fff",
          paddingBottom: "0.5rem",
        }}
      >
      <s-section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
            gap: "0.75rem",
          }}
        >
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
                <s-text color="subdued">Roll Ends Only Orders</s-text>
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
                <s-text color="subdued">Swatches Only Orders</s-text>
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
            background={currentFilter === "localPickup" ? "subdued" : "base"}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter("localPickup")}>
              <s-stack gap="small">
                <s-text color="subdued">Local Pickup Orders</s-text>
                <s-text type="strong" tone="success">
                  {stats.localPickup}
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

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack gap="small">
              <s-stack gap="small" direction="inline">
                <s-button
                  variant="tertiary"
                  disabled={undoStack.length === 0}
                  onClick={undoLastAction}
                >
                  ↶ Undo
                </s-button>
                <s-button
                  variant="tertiary"
                  disabled={redoStack.length === 0}
                  onClick={redoLastAction}
                >
                  Redo ↷
                </s-button>
              </s-stack>
              <s-text color="subdued">
                {undoStack.length > 0
                  ? `Last: ${undoStack[undoStack.length - 1].description}`
                  : "No recent action"}
              </s-text>
            </s-stack>
          </s-box>
        </div>
      </s-section>
      {newRushAlerts.length > 0 && (
        <s-section>
          <s-stack gap="small">
            {newRushAlerts.map((alert) => (
              <s-banner key={alert.orderId} tone="critical">
                <s-stack gap="base" direction="inline">
                  <s-text type="strong">
                    🚨 New rush order: {alert.orderName}
                    {alert.itemCount > 1
                      ? ` — ${alert.itemCount} items`
                      : alert.skus[0]
                        ? ` — ${alert.skus[0]}`
                        : ""}
                  </s-text>
                  <s-button
                    variant="primary"
                    onClick={() => {
                      setCurrentFilter("rush");
                      setNewRushAlerts((prev) =>
                        prev.filter((a) => a.orderId !== alert.orderId),
                      );
                    }}
                  >
                    Jump to rush
                  </s-button>
                  <s-button
                    variant="tertiary"
                    onClick={() =>
                      setNewRushAlerts((prev) =>
                        prev.filter((a) => a.orderId !== alert.orderId),
                      )
                    }
                  >
                    Dismiss
                  </s-button>
                </s-stack>
              </s-banner>
            ))}
          </s-stack>
        </s-section>
      )}
      </div>

      {(currentFilter === "pickedToday" ||
        currentFilter === "rush" ||
        currentFilter === "readyToShip" ||
        currentFilter === "localPickup") && (
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
            <s-table-header listSlot="labeled">Order Time</s-table-header>
            <s-table-header listSlot="labeled">Customer Name</s-table-header>
            <s-table-header listSlot="primary">Order Number</s-table-header>
            <s-table-header listSlot="labeled">Product Title</s-table-header>
            <s-table-header listSlot="labeled">Quantity</s-table-header>
            <s-table-header listSlot="labeled">Image</s-table-header>
            <s-table-header listSlot="labeled">Product SKU</s-table-header>
            <s-table-header listSlot="labeled">Bin Number</s-table-header>
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
                const isLocalPickup = item.orderTags.some(
                  (t) => t.toLowerCase() === "local pickup",
                );
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
    : currentFilter === "readyToShip" || currentFilter === "pickedToday"
      ? orderGroupIndex % 2 === 0
        ? "strong"
        : "base"
      : "transparent";

const showOrderGroupBorder =
  (currentFilter === "readyToShip" || currentFilter === "pickedToday") &&
  index > 0 &&
  filteredItems[index - 1]?.orderId !== item.orderId;

const isHeldRow = skippedItems.has(item.lineItemId);
const prevWasHeld =
  index > 0 &&
  skippedItems.has(filteredItems[index - 1]?.lineItemId ?? "");
const isFirstWorkingRow = !isHeldRow && prevWasHeld;

const cellStyle = {
  background: isActive ? "strong" : multipleGroupBackground,
  borderTop: isFirstWorkingRow
    ? "6px solid #d97706"
    : showOrderGroupBorder
    ? "4px solid #1f1f1f"
    : undefined,
};

                return (
                  <s-table-row
  key={itemKey}
  style={cellStyle}
  data-rush-order-id={
    newRushAlerts.some((a) => a.orderId === item.orderId)
      ? item.orderId.split("/").pop()
      : undefined
  }
>
<s-table-cell
  style={cellStyle}
>
                      <s-stack gap="small">
                        {isHeldRow && (
                          <s-badge tone="warning">Held</s-badge>
                        )}
                        {isActive && <s-badge tone="success">✓</s-badge>}
                      </s-stack>
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
                      <s-stack gap="small">
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                      <s-stack gap="small" direction="inline">
  {isRush && <s-badge tone="critical">RUSH</s-badge>}
  {isLocalPickup && <s-badge tone="success">LOCAL PICKUP</s-badge>}
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
  {item.orderNote && (
    <s-clickable
      onClick={() =>
        setNoteModalContent({
          orderName: item.orderName,
          note: item.orderNote!,
        })
      }
    >
      <s-badge tone="caution">📝 NOTE</s-badge>
    </s-clickable>
  )}
  <s-link href={`shopify://admin/orders/${orderIdNum}`}>
    {item.orderName}
  </s-link>
</s-stack>
                      </s-clickable>
                      <s-clickable onClick={() => handleProductCountClick(item)}>
                        <s-badge>
                          {item.allLineItems.filter((li) => li.sku !== VIRTUAL_SKU).length} items
                        </s-badge>
                      </s-clickable>
                      </s-stack>
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
                            <s-text color="subdued">—</s-text>
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
                          {isBundleRow ? (
                            <s-text>
                              {swatchesForOrder.reduce(
                                (sum, s) => sum + Math.max(1, s.quantity),
                                0,
                              )}{" "}
                              swatches
                            </s-text>
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
                            <s-stack gap="small">
                              <s-stack gap="small" direction="inline">
                                <s-link href={`shopify://admin/products/${productIdNum}`}>
                                  {item.sku || "-"}
                                </s-link>
                                {getVariantTypeBadge(item.variantTitle)}
                              </s-stack>
                              {item.colorCode && (
                                <s-text color="subdued">
                                  Color Code: {item.colorCode}
                                </s-text>
                              )}
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
                          <s-text>{item.binNumber || "-"}</s-text>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>

                    <s-table-cell
  style={cellStyle}
>
                      {currentFilter === "pickedToday" ||
                      currentFilter === "readyToShip" ? (
                        <s-stack gap="small">
                          <s-text>{getPickedByName(item)}</s-text>
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
                              <s-clickable
                                onClick={() => openReadyToShipModal(item.orderId)}
                              >
                                <s-badge tone="success">Move to Ready to Ship</s-badge>
                              </s-clickable>
                              <s-clickable
                                onClick={() =>
                                  setMoveToCutListConfirm(
                                    isBundleRow ? swatchesForOrder : [item],
                                  )
                                }
                              >
                                <s-badge tone="caution">Move to Cut List</s-badge>
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
                            Move to Ready to Ship
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

                      {currentFilter !== "pickedToday" &&
                        currentFilter !== "readyToShip" &&
                        !printedLines.has(item.lineItemId) && (
                          <div style={{ marginTop: "0.5rem" }}>
                            <s-clickable
                              onClick={() =>
                                isHeldRow ? unskipItem(item) : skipItem(item)
                              }
                            >
                              <s-badge tone={isHeldRow ? "info" : "caution"}>
                                {isHeldRow ? "Unskip" : "Skip"}
                              </s-badge>
                            </s-clickable>
                          </div>
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
        ref={noteModalRef}
        onHide={() => setNoteModalContent(null)}
      >
        <s-box padding="base">
          <s-text>{noteModalContent?.note}</s-text>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => {
            noteModalRef.current?.hideOverlay?.();
            setNoteModalContent(null);
          }}
        >
          Acknowledge
        </s-button>
      </s-modal>

      <s-modal
        id="move-to-cut-list-modal"
        heading="Move back to Cut List?"
        ref={moveToCutListModalRef}
        onHide={() => setMoveToCutListConfirm(null)}
      >
        <s-box padding="base">
          <s-text>
            This will place this item back on the cut list, meaning it will
            need to be scanned and cut again as if it had just been ordered.
            Confirm this is what you want?
          </s-text>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => {
            if (moveToCutListConfirm) {
              moveItemsToCutList(moveToCutListConfirm);
            }
            moveToCutListModalRef.current?.hideOverlay?.();
            setMoveToCutListConfirm(null);
          }}
        >
          Confirm
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => {
            moveToCutListModalRef.current?.hideOverlay?.();
            setMoveToCutListConfirm(null);
          }}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        id="completion-modal"
        heading="Order Complete"
        ref={completionModalRef}
        onHide={() => setCompletionMessage(null)}
      >
        <s-box padding="base">
          <s-text>{completionMessage}</s-text>
        </s-box>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => {
            completionModalRef.current?.hideOverlay?.();
            setCompletionMessage(null);
          }}
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
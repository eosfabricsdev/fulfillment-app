// @ts-nocheck
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

const VIRTUAL_SKU = '85496775805861';

interface Metafield {
  key: string;
  value: string;
  namespace: string;
}

interface Variant {
  id: string;
  barcode: string | null;
  inventoryQuantity: number;
  metafields: {
    edges: Array<{
      node: Metafield;
    }>;
  };
}

interface Product {
  id: string;
  featuredImage: {
    url: string;
    altText: string | null;
  } | null;
}

interface LineItem {
  id: string;
  title: string;
  quantity: number;
  currentQuantity: number;
  fulfillmentStatus: string | null;
  sku: string;
  vendor: string;
  variantTitle: string | null;
  product: Product;
  variant: Variant | null;
}

interface Customer {
  id: string;
  displayName: string;
}

interface FulfillmentHold {
  reason: string;
}

interface FulfillmentOrder {
  id: string;
  fulfillmentHolds: FulfillmentHold[];
}

interface Order {
  id: string;
  name: string;
  createdAt: string;
  note: string | null;
  tags: string[];
  customer: Customer | null;
  fulfillmentOrders: {
    nodes: FulfillmentOrder[];
  };
  lineItems: {
    edges: Array<{
      node: LineItem;
    }>;
  };
}

interface CutListItem {
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
}

function Extension() {
  const [cutListItems, setCutListItems] = useState<CutListItem[]>([]);
  const [pageInfo, setPageInfo] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set());
  const [printedLines, setPrintedLines] = useState<Set<string>>(new Set());
  const [readyToPrint, setReadyToPrint] = useState<Set<string>>(new Set());
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());
  const [employeeName, setEmployeeName] = useState<string>('Unknown');
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [currentDirection, setCurrentDirection] = useState<string>('forward');

  const [currentOrderForModal, setCurrentOrderForModal] = useState<CutListItem | null>(null);
  const [barcodeInputs, setBarcodeInputs] = useState<{ [key: string]: string }>({});
  const [barcodeErrors, setBarcodeErrors] = useState<{ [key: string]: string }>({});
  const [currentFilter, setCurrentFilter] = useState<
    'all' | 'rush' | 'rollEnds' | 'swatches' | 'pickedToday'
  >('all');
  const [pickedTodayItems, setPickedTodayItems] = useState<CutListItem[]>([]);
  const [rushOrders, setRushOrders] = useState<Order[]>([]);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [showProductCountModal, setShowProductCountModal] = useState<boolean>(false);
  const [productCountModalItems, setProductCountModalItems] = useState<LineItem[]>([]);
  const [productCountModalOrderName, setProductCountModalOrderName] = useState<string>('');
  const [previewImage, setPreviewImage] = useState<{ url: string; alt: string } | null>(null);

  const barcodeInputRefs = useRef<{ [key: string]: any }>({});

  const fetchEmployeeName = async () => {
    const query = `query {
      currentStaffMember {
        name
      }
    }`;

    try {
      const { data, errors } = await shopify.query(query);
      if (errors?.length > 0) {
        setEmployeeName('Unknown');
        return;
      }
      if (data?.currentStaffMember?.name) {
        setEmployeeName(data.currentStaffMember.name);
      }
    } catch (err) {
      setEmployeeName('Unknown');
    }
  };

  const fetchRushOrders = async () => {
    const query = `query GetRushOrders {
      orders(
        first: 50
        query: "fulfillment_status:unfulfilled -status:cancelled tag:rush"
      ) {
        edges {
          node {
            id
            name
            createdAt
            note
            tags
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
                    metafields(first: 3) {
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
      }
    }`;

    try {
      const { data, errors } = await shopify.query(query);

      if (errors?.length > 0) {
        setError(errors.map((e) => e.message).join(', '));
        return;
      }

      if (data?.orders) {
        setRushOrders(data.orders.edges.map((e: any) => e.node));
      }
    } catch (err: any) {
      // Silently continue on network errors (502, etc.)
    }
  };

  const fetchPickedTodayOrders = async () => {
    const query = `query GetPickedOrders {
      orders(
        first: 50
        query: "tag:picked OR tag:'partially picked'"
      ) {
        edges {
          node {
            id
            name
            createdAt
            note
            tags
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
                    metafields(first: 3) {
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
      }
    }`;

    try {
      const { data, errors } = await shopify.query(query);

      if (errors?.length > 0) {
        setError(errors.map((e) => e.message).join(', '));
        return;
      }

      if (data?.orders) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];

        const ordersPickedToday = data.orders.edges
          .map((e: any) => e.node)
          .filter((order: Order) => {
            return order.tags.some((tag) => {
              try {
                const date = new Date(tag);
                if (!isNaN(date.getTime())) {
                  const tagDateStr = date.toISOString().split('T')[0];
                  return tagDateStr === todayStr;
                }
              } catch (err) {
                return false;
              }
              return false;
            });
          });

        const items = processPickedTodayItems(ordersPickedToday);
        setPickedTodayItems(items);
      }
    } catch (err: any) {
      // Silently continue on network errors (502, etc.)
    }
  };

  const processPickedTodayItems = (orders: Order[]): CutListItem[] => {
    const items: CutListItem[] = [];

    for (const order of orders) {
      const hasHold = order.fulfillmentOrders.nodes.some((fo) => fo.fulfillmentHolds.length > 0);
      const allLineItems = order.lineItems.edges.map((e) => e.node);

      for (const edge of order.lineItems.edges) {
        const lineItem = edge.node;

        if (lineItem.sku === VIRTUAL_SKU) continue;

        const binNumber =
          lineItem.variant?.metafields.edges.find((e) => e.node.key === 'bin_number')?.node.value ||
          '';

        items.push({
          orderId: order.id,
          orderName: order.name,
          orderCreatedAt: order.createdAt,
          orderNote: order.note,
          orderTags: order.tags,
          customerId: order.customer?.id || null,
          customerName: order.customer?.displayName || 'Guest',
          lineItemId: lineItem.id,
          productId: lineItem.product.id,
          productTitle: lineItem.title,
          sku: lineItem.sku,
          variantTitle: lineItem.variantTitle,
          quantity: lineItem.currentQuantity,
          variantId: lineItem.variant?.id || '',
          barcode: lineItem.variant?.barcode || null,
          binNumber,
          hasHold,
          allLineItems,
          productImage: lineItem.product.featuredImage?.url || null,
          productImageAlt: lineItem.product.featuredImage?.altText || null,
        });
      }
    }

    return items;
  };

  const fetchOrders = async (cursor: string | null = null, direction: string = 'forward') => {
    setLoading(true);
    setError(null);

    const query = `query GetOrders($first: Int, $after: String, $last: Int, $before: String) {
      orders(
        first: $first
        after: $after
        last: $last
        before: $before
        query: "fulfillment_status:unfulfilled -status:cancelled -tag:picked -tag:'picked by EasyScan'"
      ) {
        edges {
          node {
            id
            name
            createdAt
            note
            tags
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
                    metafields(first: 3) {
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
    }`;

    try {
      const { data, errors } = await shopify.query(query, {
        variables: {
          first: direction === 'forward' ? 50 : null,
          after: direction === 'forward' ? cursor : null,
          last: direction !== 'forward' ? 50 : null,
          before: direction !== 'forward' ? cursor : null,
        },
      });

      if (errors?.length > 0) {
        const errorMessage = errors.map((e) => e.message).join(', ');
        setError(errorMessage);
        setLoading(false);
        return;
      }

      if (data?.orders) {
        const items = processCutListItems(data.orders.edges.map((e: any) => e.node));
        setCutListItems(items);
        setPageInfo(data.orders.pageInfo);
        setLastUpdated(new Date());
        setSecondsSinceUpdate(0);
      }
    } catch (err: any) {
      // Silently continue on network errors (502, etc.)
    } finally {
      setLoading(false);
    }
  };

  const processCutListItems = (orders: Order[]): CutListItem[] => {
    const items: CutListItem[] = [];

    for (const order of orders) {
      const hasHold = order.fulfillmentOrders.nodes.some((fo) => fo.fulfillmentHolds.length > 0);
      const allLineItems = order.lineItems.edges.map((e) => e.node);

      for (const edge of order.lineItems.edges) {
        const lineItem = edge.node;

        if (lineItem.fulfillmentStatus === 'FULFILLED') continue;
        if (lineItem.currentQuantity === 0) continue;
        if (pickedItems.has(lineItem.id)) continue;
        if (lineItem.sku === VIRTUAL_SKU) continue;

        const binNumber =
          lineItem.variant?.metafields.edges.find((e) => e.node.key === 'bin_number')?.node.value ||
          '';

        items.push({
          orderId: order.id,
          orderName: order.name,
          orderCreatedAt: order.createdAt,
          orderNote: order.note,
          orderTags: order.tags,
          customerId: order.customer?.id || null,
          customerName: order.customer?.displayName || 'Guest',
          lineItemId: lineItem.id,
          productId: lineItem.product.id,
          productTitle: lineItem.title,
          sku: lineItem.sku,
          variantTitle: lineItem.variantTitle,
          quantity: lineItem.currentQuantity,
          variantId: lineItem.variant?.id || '',
          barcode: lineItem.variant?.barcode || null,
          binNumber,
          hasHold,
          allLineItems,
          productImage: lineItem.product.featuredImage?.url || null,
          productImageAlt: lineItem.product.featuredImage?.altText || null,
        });
      }
    }

    return applyRushFirstSort(items);
  };

  const processRushItems = (orders: Order[]): CutListItem[] => {
    const items: CutListItem[] = [];

    for (const order of orders) {
      const hasHold = order.fulfillmentOrders.nodes.some((fo) => fo.fulfillmentHolds.length > 0);
      const allLineItems = order.lineItems.edges.map((e) => e.node);

      for (const edge of order.lineItems.edges) {
        const lineItem = edge.node;

        if (lineItem.fulfillmentStatus === 'FULFILLED') continue;
        if (lineItem.currentQuantity === 0) continue;
        if (lineItem.sku === VIRTUAL_SKU) continue;

        const binNumber =
          lineItem.variant?.metafields.edges.find((e) => e.node.key === 'bin_number')?.node.value ||
          '';

        items.push({
          orderId: order.id,
          orderName: order.name,
          orderCreatedAt: order.createdAt,
          orderNote: order.note,
          orderTags: order.tags,
          customerId: order.customer?.id || null,
          customerName: order.customer?.displayName || 'Guest',
          lineItemId: lineItem.id,
          productId: lineItem.product.id,
          productTitle: lineItem.title,
          sku: lineItem.sku,
          variantTitle: lineItem.variantTitle,
          quantity: lineItem.currentQuantity,
          variantId: lineItem.variant?.id || '',
          barcode: lineItem.variant?.barcode || null,
          binNumber,
          hasHold,
          allLineItems,
          productImage: lineItem.product.featuredImage?.url || null,
          productImageAlt: lineItem.product.featuredImage?.altText || null,
        });
      }
    }

    items.sort(
      (a, b) => new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime(),
    );
    return items;
  };

  const applyRushFirstSort = (items: CutListItem[]): CutListItem[] => {
    const rushOrderIds = new Set(rushOrders.map((o) => o.id));
    const rushItems = items.filter((item) => rushOrderIds.has(item.orderId));
    const nonRushItems = items.filter((item) => !rushOrderIds.has(item.orderId));

    rushItems.sort(
      (a, b) => new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime(),
    );

    const sortedNonRush = applyCustomerBatchingSort(nonRushItems);

    return [...rushItems, ...sortedNonRush];
  };

  const applyCustomerBatchingSort = (items: CutListItem[]): CutListItem[] => {
    const customerGroups = new Map<string, CutListItem[]>();

    for (const item of items) {
      const key = item.customerId || 'guest';
      if (!customerGroups.has(key)) {
        customerGroups.set(key, []);
      }
      customerGroups.get(key)!.push(item);
    }

    const customerGroupsWithLatest = Array.from(customerGroups.entries()).map(
      ([customerId, items]) => {
        const latestTime = Math.max(...items.map((i) => new Date(i.orderCreatedAt).getTime()));
        return { customerId, items, latestTime };
      },
    );

    customerGroupsWithLatest.sort((a, b) => a.latestTime - b.latestTime);

    const sortedItems: CutListItem[] = [];
    for (const group of customerGroupsWithLatest) {
      group.items.sort(
        (a, b) => new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime(),
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
        (a, b) => new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime(),
      );
      finalItems.push(...skuGroup);
      processedSkus.add(item.sku);
    }

    return finalItems;
  };

  const handleNextPage = () => {
    if (pageInfo?.hasNextPage) {
      setCurrentCursor(pageInfo.endCursor);
      setCurrentDirection('forward');
      fetchOrders(pageInfo.endCursor, 'forward');
    }
  };

  const handlePreviousPage = () => {
    if (pageInfo?.hasPreviousPage) {
      setCurrentCursor(pageInfo.startCursor);
      setCurrentDirection('backward');
      fetchOrders(pageInfo.startCursor, 'backward');
    }
  };

  const generateBinLabelHtml = (orderName: string): string => {
    const orderNum = orderName.replace('#', '');
    return `<div style="width:57mm;height:25mm;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,sans-serif;padding:1mm;overflow:hidden;box-sizing:border-box;">
      <div style="font-size:11pt;font-weight:bold;margin-bottom:1mm;letter-spacing:0.5px;">ORDER ${orderName}</div>
      <svg id="barcode" data-barcode-value="${orderNum}" data-barcode-format="CODE128" data-barcode-display="true" data-barcode-height="30" style="width:52mm;height:12mm;"></svg>
    </div>`;
  };

  const generateCutLabelHtml = (item: CutListItem): string => {
    const barcode = item.barcode || '';
    const yardage = item.variantTitle?.includes('By the Yard')
      ? ' / ' + (item.quantity / 4).toFixed(2) + ' yds'
      : '';
    const qtyDisplay = item.quantity + ' units' + yardage;
    const safeTitle = item.productTitle
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const safeVariant = (item.variantTitle || '')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const safeSku = item.sku.replace(/"/g, '&quot;');

    return `<div style="width:57mm;height:25mm;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;font-family:Arial,sans-serif;padding:1mm 1.5mm;overflow:hidden;box-sizing:border-box;">
      <div style="font-size:7pt;font-weight:bold;line-height:1.2;width:54mm;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${safeTitle}</div>
      <div style="font-size:5.5pt;color:#333;margin-bottom:0.8mm;line-height:1.3;">${safeVariant} | ${item.orderName} | ${qtyDisplay}</div>
      ${
        barcode
          ? `<svg id="barcode" data-barcode-value="${barcode}" data-barcode-format="CODE128" data-barcode-display="false" data-barcode-height="28" style="width:52mm;height:9mm;"></svg>`
          : `<div style="font-size:6pt;color:red;margin:1mm 0;">No barcode on file</div>`
      }
      <div style="font-size:5.5pt;color:#555;margin-top:0.3mm;">SKU: ${safeSku}</div>
    </div>`;
  };

  const handleBarcodeScan = async (itemKey: string, value: string, item: CutListItem) => {
    setBarcodeInputs((prev) => ({ ...prev, [itemKey]: value }));
    setBarcodeErrors((prev) => {
      const n = { ...prev };
      delete n[itemKey];
      return n;
    });

    if (!value) return;

    if (!item.barcode) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: 'NO_BARCODE' }));
      return;
    }

    if (value !== item.barcode) {
      setBarcodeErrors((prev) => ({ ...prev, [itemKey]: 'MISMATCH' }));
      return;
    }

    setReadyToPrint((prev) => new Set(prev).add(item.lineItemId));

    setPickedItems((prev) => new Set(prev).add(item.lineItemId));
    setBarcodeInputs((prev) => ({ ...prev, [itemKey]: '' }));

    await handleOrderTagging(item);

    const currentIndex = filteredItems.findIndex((i) => i.lineItemId === item.lineItemId);
    const nextItem = filteredItems[currentIndex + 1];
    if (nextItem) {
      setActiveLineId(nextItem.lineItemId);
    }
  };

  const handleOrderTagging = async (item: CutListItem) => {
    const orderItems = cutListItems.filter((i) => i.orderId === item.orderId);
    const pickedCount = orderItems.filter(
      (i) => pickedItems.has(i.lineItemId) || i.lineItemId === item.lineItemId,
    ).length;
    const totalCount = orderItems.filter((i) => i.sku !== VIRTUAL_SKU).length;

    const timestamp = new Date().toISOString();

    if (pickedCount === 1) {
      const mutation = `mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`;

      try {
        const { data, errors } = await shopify.query(mutation, {
          variables: {
            id: item.orderId,
            tags: ['partially picked', employeeName, timestamp],
          },
        });

        if (errors?.length > 0) {
          const errorMessage = errors.map((e) => e.message).join(', ');
          setError(errorMessage);
          return;
        }

        if (data?.tagsAdd?.userErrors?.length > 0) {
          const userErrorMessage = data.tagsAdd.userErrors
            .map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message))
            .join(', ');
          setError(userErrorMessage);
          return;
        }
      } catch (err: any) {
        setError(err.message || 'Failed to tag order');
      }
    } else if (pickedCount === totalCount) {
      const removeMutation = `mutation TagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`;

      const addMutation = `mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`;

      try {
        const { data: removeData, errors: removeErrors } = await shopify.query(removeMutation, {
          variables: {
            id: item.orderId,
            tags: ['partially picked'],
          },
        });

        if (removeErrors?.length > 0) {
          const errorMessage = removeErrors.map((e) => e.message).join(', ');
          setError(errorMessage);
          return;
        }

        if (removeData?.tagsRemove?.userErrors?.length > 0) {
          const userErrorMessage = removeData.tagsRemove.userErrors
            .map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message))
            .join(', ');
          setError(userErrorMessage);
          return;
        }

        const { data: addData, errors: addErrors } = await shopify.query(addMutation, {
          variables: {
            id: item.orderId,
            tags: ['picked', employeeName, timestamp],
          },
        });

        if (addErrors?.length > 0) {
          const errorMessage = addErrors.map((e) => e.message).join(', ');
          setError(errorMessage);
          return;
        }

        if (addData?.tagsAdd?.userErrors?.length > 0) {
          const userErrorMessage = addData.tagsAdd.userErrors
            .map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message))
            .join(', ');
          setError(userErrorMessage);
          return;
        }
      } catch (err: any) {
        setError(err.message || 'Failed to tag order');
      }
    }
  };

  const handleProductCountClick = (item: CutListItem) => {
    setProductCountModalItems(item.allLineItems);
    setProductCountModalOrderName(item.orderName);
    setShowProductCountModal(true);
  };

  const getVariantTypeBadge = (variantTitle: string | null) => {
    if (!variantTitle) return null;

    if (variantTitle.includes('By the Yard')) {
      return <s-badge tone="info">By the Yard</s-badge>;
    } else if (variantTitle.includes('Swatch Sample')) {
      return <s-badge tone="warning">Swatch Sample</s-badge>;
    } else if (variantTitle.includes('Panel')) {
      return <s-badge tone="caution">Panel</s-badge>;
    } else if (variantTitle.includes('Yard Piece')) {
      return <s-badge tone="success">{variantTitle}</s-badge>;
    }
    return null;
  };

  const formatQuantity = (quantity: number, variantTitle: string | null) => {
    if (variantTitle?.includes('By the Yard')) {
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

  const isRushOrder = (orderTags: string[]): boolean => {
    return orderTags.some((tag) => tag.toLowerCase() === 'rush');
  };

  const getPickedByName = (orderTags: string[]): string => {
    const excludeTags = ['picked', 'partially picked', 'printed', 'rush'];
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}/;

    for (const tag of orderTags) {
      if (!excludeTags.includes(tag.toLowerCase()) && !isoDatePattern.test(tag)) {
        return tag;
      }
    }
    return employeeName;
  };

  const getFilteredItems = (): CutListItem[] => {
    if (currentFilter === 'pickedToday') {
      return pickedTodayItems;
    }

    if (currentFilter === 'rush') {
      return processRushItems(rushOrders);
    }

    const allItems = cutListItems;

    if (currentFilter === 'rollEnds') {
      const rollEndOrders = new Set<string>();
      const orderMap = new Map<string, CutListItem[]>();

      allItems.forEach((item) => {
        if (!orderMap.has(item.orderId)) {
          orderMap.set(item.orderId, []);
        }
        orderMap.get(item.orderId)!.push(item);
      });

      orderMap.forEach((items, orderId) => {
        const allAreYardPiece = items.every((item) => item.variantTitle?.includes('Yard Piece'));
        if (allAreYardPiece) {
          rollEndOrders.add(orderId);
        }
      });

      return allItems.filter((item) => rollEndOrders.has(item.orderId));
    }

    if (currentFilter === 'swatches') {
      const swatchOrders = new Set<string>();
      const orderMap = new Map<string, CutListItem[]>();

      allItems.forEach((item) => {
        if (!orderMap.has(item.orderId)) {
          orderMap.set(item.orderId, []);
        }
        orderMap.get(item.orderId)!.push(item);
      });

      orderMap.forEach((items, orderId) => {
        const allAreSwatches = items.every((item) => item.variantTitle?.includes('Swatch Sample'));
        if (allAreSwatches) {
          swatchOrders.add(orderId);
        }
      });

      return allItems.filter((item) => swatchOrders.has(item.orderId));
    }

    return allItems;
  };

  const getSummaryStats = () => {
    const filteredCutListItems = cutListItems.filter((item) => item.sku !== VIRTUAL_SKU);
    const uniqueOrders = new Set(filteredCutListItems.map((i) => i.orderId));
    const uniqueSkus = new Set(filteredCutListItems.map((i) => i.sku));
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
      const allAreYardPiece = items.every((item) => item.variantTitle?.includes('Yard Piece'));
      const allAreSwatches = items.every((item) => item.variantTitle?.includes('Swatch Sample'));

      if (allAreYardPiece) rollEndsOnlyCount++;
      if (allAreSwatches) swatchesOnlyCount++;
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const filteredPickedTodayItems = pickedTodayItems.filter((item) => item.sku !== VIRTUAL_SKU);
    const uniqueOrdersToday = new Set<string>();
    let itemsCountToday = 0;

    filteredPickedTodayItems.forEach((item) => {
      const hasTimestampToday = item.orderTags.some((tag) => {
        try {
          const date = new Date(tag);
          if (!isNaN(date.getTime())) {
            const tagDateStr = date.toISOString().split('T')[0];
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

  const isFirstItemInOrder = (item: CutListItem, index: number) => {
    if (index === 0) return true;
    return cutListItems[index - 1].orderId !== item.orderId;
  };

  useEffect(() => {
    fetchEmployeeName();
    fetchOrders();
    const rushTimer = setTimeout(() => fetchRushOrders(), 500);
    const pickedTimer = setTimeout(() => fetchPickedTodayOrders(), 1000);
    return () => {
      clearTimeout(rushTimer);
      clearTimeout(pickedTimer);
    };
  }, []);

  useEffect(() => {
    if (filteredItems.length > 0 && !activeLineId) {
      setActiveLineId(filteredItems[0].lineItemId);
    }
  }, [cutListItems, rushOrders, currentFilter]);

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      fetchOrders(currentCursor, currentDirection);
      fetchRushOrders();
      fetchPickedTodayOrders();
    }, 30000);

    return () => clearInterval(refreshInterval);
  }, [currentCursor, currentDirection]);

  useEffect(() => {
    const timestampInterval = setInterval(() => {
      const now = new Date();
      const diff = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
      setSecondsSinceUpdate(diff);
    }, 1000);

    return () => clearInterval(timestampInterval);
  }, [lastUpdated]);

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
            background={currentFilter === 'rush' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('rush')}>
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
            background={currentFilter === 'pickedToday' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('pickedToday')}>
              <s-stack gap="small">
                <s-text color="subdued">Orders Cut Today</s-text>
                <s-text type="strong">{stats.ordersCutToday}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>
          <s-box
            padding="base"
            background={currentFilter === 'pickedToday' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('pickedToday')}>
              <s-stack gap="small">
                <s-text color="subdued">Items Cut Today</s-text>
                <s-text type="strong">{stats.itemsCutToday}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>
          <s-box
            padding="base"
            background={currentFilter === 'all' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('all')}>
              <s-stack gap="small">
                <s-text color="subdued">Total Orders to Pick</s-text>
                <s-text type="strong">{stats.totalOrders}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>
          <s-box
            padding="base"
            background={currentFilter === 'all' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('all')}>
              <s-stack gap="small">
                <s-text color="subdued">Total Cuts to Pick</s-text>
                <s-text type="strong">{stats.totalCuts}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>
          <s-box
            padding="base"
            background={currentFilter === 'rollEnds' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('rollEnds')}>
              <s-stack gap="small">
                <s-text color="subdued">Roll Ends Only</s-text>
                <s-text type="strong">{stats.rollEndsOnly}</s-text>
              </s-stack>
            </s-clickable>
          </s-box>
          <s-box
            padding="base"
            background={currentFilter === 'swatches' ? 'subdued' : 'base'}
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-clickable onClick={() => setCurrentFilter('swatches')}>
              <s-stack gap="small">
                <s-text color="subdued">Swatches Only</s-text>
                <s-text type="strong">{stats.swatchesOnly}</s-text>
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

      {(currentFilter === 'pickedToday' || currentFilter === 'rush') && (
        <s-section>
          <s-button variant="secondary" onClick={() => setCurrentFilter('all')}>
            Back to Cut List
          </s-button>
        </s-section>
      )}

      <s-section padding="none">
        <s-table
          paginate={currentFilter !== 'pickedToday' && currentFilter !== 'rush'}
          loading={loading}
          hasNextPage={
            currentFilter !== 'pickedToday' &&
            currentFilter !== 'rush' &&
            (pageInfo?.hasNextPage || false)
          }
          hasPreviousPage={
            currentFilter !== 'pickedToday' &&
            currentFilter !== 'rush' &&
            (pageInfo?.hasPreviousPage || false)
          }
          onNextPage={handleNextPage}
          onPreviousPage={handlePreviousPage}
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
              {currentFilter === 'pickedToday' ? 'Picked By' : 'Actions'}
            </s-table-header>
            <s-table-header listSlot="labeled">Order Tags</s-table-header>
            <s-table-header listSlot="labeled"></s-table-header>
          </s-table-header-row>

          <s-table-body>
            {filteredItems.length === 0 && !loading ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {currentFilter === 'pickedToday'
                      ? 'No orders picked today'
                      : 'No orders to pick'}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ) : (
              filteredItems.map((item, index) => {
                const itemKey = `${item.lineItemId}`;
                const orderIdNum = item.orderId.split('/').pop();
                const customerIdNum = item.customerId?.split('/').pop();
                const productIdNum = item.productId.split('/').pop();
                const isFirstInOrder =
                  index === 0 || filteredItems[index - 1].orderId !== item.orderId;
                const isActive = activeLineId === item.lineItemId;
                const isRush = isRushOrder(item.orderTags);

                return (
                  <s-table-row key={itemKey}>
                    <s-table-cell>{isActive && <s-badge tone="success">✓</s-badge>}</s-table-cell>
                    <s-table-cell>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                        <s-stack gap="small" direction="inline">
                          {isRush && <s-badge tone="critical">RUSH</s-badge>}
                          {item.hasHold && <s-badge tone="critical">HOLD</s-badge>}
                          <s-link href={`shopify://admin/orders/${orderIdNum}`}>
                            {item.orderName}
                          </s-link>
                        </s-stack>
                      </s-clickable>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
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
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-text>{item.binNumber}</s-text>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-stack gap="small" direction="inline">
                            <s-link href={`shopify://admin/products/${productIdNum}`}>
                              {item.sku}
                            </s-link>
                            {getVariantTypeBadge(item.variantTitle)}
                          </s-stack>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
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
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-link href={`shopify://admin/products/${productIdNum}`}>
                            {item.productTitle}
                          </s-link>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          {!item.variantTitle?.includes('By the Yard') && item.quantity > 1 ? (
                            <s-badge tone="critical">⚠️ {item.quantity} units</s-badge>
                          ) : (
                            formatQuantity(item.quantity, item.variantTitle)
                          )}
                        </s-clickable>
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box
                        padding="small"
                        background={isActive ? 'strong' : 'transparent'}
                        borderRadius="small"
                      >
                        <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                          <s-text>{formatTimestamp(item.orderCreatedAt)}</s-text>
                        </s-clickable>
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" onClick={() => handleProductCountClick(item)}>
                        {item.allLineItems.filter((li) => li.sku !== VIRTUAL_SKU).length} items
                      </s-button>
                    </s-table-cell>
                    <s-table-cell>
                      {currentFilter === 'pickedToday' ? (
                        <s-text>{getPickedByName(item.orderTags)}</s-text>
                      ) : printedLines.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Label sent to printer</s-badge>
                          <s-link
  href={`/print-label-both?lineItemId=${encodeURIComponent(item.lineItemId)}&orderId=${encodeURIComponent(item.orderId)}&reprint=true`}
  target="_blank"
>
  Reprint
</s-link>
                        </s-stack>
                      ) : readyToPrint.has(item.lineItemId) ? (
                        <s-stack gap="small">
                          <s-badge tone="success">✓ Scan verified</s-badge>
                          <s-link
  href={`/print-label-both?lineItemId=${encodeURIComponent(item.lineItemId)}&orderId=${encodeURIComponent(item.orderId)}`}
  target="_blank"
>
  Print Labels
</s-link>
                        </s-stack>
                      ) : isActive ? (
                        <s-stack gap="small">
                          <s-text-field
                            label="Scan Barcode"
                            labelAccessibilityVisibility="exclusive"
                            placeholder="Scan barcode to verify item"
                            value={barcodeInputs[itemKey] || ''}
                            onInput={(e) => handleBarcodeScan(itemKey, e.currentTarget.value, item)}
                          />
                          {barcodeErrors[itemKey] === 'NO_BARCODE' && (
                            <s-banner tone="warning">
                              <s-text>
                                No barcode on file. Please add a barcode to this product variant in
                                Shopify before continuing fulfillment.
                              </s-text>
                            </s-banner>
                          )}
                          {barcodeErrors[itemKey] === 'MISMATCH' && (
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
                    <s-table-cell>
                      <s-clickable onClick={() => setActiveLineId(item.lineItemId)}>
                        <s-stack gap="small" direction="inline">
                          {item.orderTags.map((tag) => (
                            <s-badge key={tag}>{tag}</s-badge>
                          ))}
                        </s-stack>
                      </s-clickable>
                    </s-table-cell>
                    <s-table-cell>{isActive && <s-badge tone="success">✓</s-badge>}</s-table-cell>
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
              const isPicked = pickedItems.has(li.id);
              const productIdNum = li.product.id.split('/').pop();
              return (
                <s-text key={li.id} color={isPicked ? 'subdued' : 'base'}>
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
        heading={previewImage?.alt || 'Product Image'}
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

export default (): void => render(<Extension />, document.body);
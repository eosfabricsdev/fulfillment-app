// @ts-nocheck
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type DailyRow = {
  date: string;
  cutterName: string;
  ordersCut: number;
  itemsCut: number;
};

type DailyTotal = {
  date: string;
  ordersCut: number;
  itemsCut: number;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const perCutterRows = await prisma.$queryRaw<
    Array<{
      cut_date: Date;
      cutter_name: string;
      orders_cut: bigint;
      items_cut: bigint;
    }>
  >`
    SELECT
      DATE("createdAt") AS cut_date,
      "cutterName" AS cutter_name,
      COUNT(DISTINCT "orderId") AS orders_cut,
      COUNT(*) AS items_cut
    FROM "CutEvent"
    WHERE "shop" = ${session.shop}
      AND "createdAt" >= ${thirtyDaysAgo}
    GROUP BY DATE("createdAt"), "cutterName"
    ORDER BY cut_date DESC, cutter_name ASC
  `;

  const dailyTotalsRows = await prisma.$queryRaw<
    Array<{ cut_date: Date; orders_cut: bigint; items_cut: bigint }>
  >`
    SELECT
      DATE("createdAt") AS cut_date,
      COUNT(DISTINCT "orderId") AS orders_cut,
      COUNT(*) AS items_cut
    FROM "CutEvent"
    WHERE "shop" = ${session.shop}
      AND "createdAt" >= ${thirtyDaysAgo}
    GROUP BY DATE("createdAt")
    ORDER BY cut_date DESC
  `;

  const perCutter: DailyRow[] = perCutterRows.map((r) => ({
    date: r.cut_date.toISOString().split("T")[0],
    cutterName: r.cutter_name,
    ordersCut: Number(r.orders_cut),
    itemsCut: Number(r.items_cut),
  }));

  const dailyTotals: DailyTotal[] = dailyTotalsRows.map((r) => ({
    date: r.cut_date.toISOString().split("T")[0],
    ordersCut: Number(r.orders_cut),
    itemsCut: Number(r.items_cut),
  }));

  return { dailyTotals, perCutter };
};

export default function HistoryPage() {
  const { dailyTotals, perCutter } = useLoaderData<typeof loader>();

  const cuttersByDate = new Map<string, DailyRow[]>();
  for (const row of perCutter) {
    if (!cuttersByDate.has(row.date)) {
      cuttersByDate.set(row.date, []);
    }
    cuttersByDate.get(row.date)!.push(row);
  }

  const formatDate = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <s-page heading="Cut History (last 30 days)" inlineSize="large">
      {dailyTotals.length === 0 ? (
        <s-section>
          <s-text color="subdued">No cut activity in the last 30 days.</s-text>
        </s-section>
      ) : (
        dailyTotals.map((day) => {
          const cutters = cuttersByDate.get(day.date) || [];
          return (
            <s-section key={day.date} heading={formatDate(day.date)}>
              <s-stack gap="base">
                <s-stack gap="base" direction="inline">
                  <s-box
                    padding="base"
                    background="subdued"
                    borderWidth="base"
                    borderColor="base"
                    borderRadius="base"
                  >
                    <s-stack gap="small">
                      <s-text color="subdued">Total Orders Cut</s-text>
                      <s-text type="strong">{day.ordersCut}</s-text>
                    </s-stack>
                  </s-box>
                  <s-box
                    padding="base"
                    background="subdued"
                    borderWidth="base"
                    borderColor="base"
                    borderRadius="base"
                  >
                    <s-stack gap="small">
                      <s-text color="subdued">Total Items Cut</s-text>
                      <s-text type="strong">{day.itemsCut}</s-text>
                    </s-stack>
                  </s-box>
                </s-stack>

                {cutters.length > 0 && (
                  <s-table paginate={false} loading={false} hasNextPage={false} hasPreviousPage={false}>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Cutter</s-table-header>
                      <s-table-header listSlot="labeled">Orders Cut</s-table-header>
                      <s-table-header listSlot="labeled">Items Cut</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {cutters.map((c) => (
                        <s-table-row key={`${day.date}-${c.cutterName}`}>
                          <s-table-cell>
                            <s-text>{c.cutterName}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text>{c.ordersCut}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text>{c.itemsCut}</s-text>
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}
              </s-stack>
            </s-section>
          );
        })
      )}
    </s-page>
  );
}

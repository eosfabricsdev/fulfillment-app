import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

type PrintData = {
  orderName: string;
  orderTags: string[];
  lineItemId: string;
  productTitle: string;
  variantTitle: string | null;
  quantity: number;
  sku: string;
  barcode: string | null;
  includeBin: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const orderName = url.searchParams.get("orderName") || "TEST ORDER";
  const productTitle = url.searchParams.get("productTitle") || "TEST PRODUCT";
  const variantTitle = url.searchParams.get("variantTitle") || null;
  const quantity = Number(url.searchParams.get("quantity") || "1");
  const sku = url.searchParams.get("sku") || "TEST-SKU";
  const barcode = url.searchParams.get("barcode") || "";
  const includeBin = url.searchParams.get("includeBin") !== "false";

  return {
    orderName,
    orderTags: [],
    lineItemId: "test",
    productTitle,
    variantTitle,
    quantity,
    sku,
    barcode: barcode || null,
    includeBin,
  };
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getQtyDisplay(quantity: number, variantTitle: string | null) {
  if (variantTitle?.includes("By the Yard")) {
    return `${quantity} units / ${(quantity / 4).toFixed(2)} yds`;
  }
  return `${quantity} units`;
}

function generateBinLabelHtml(orderName: string): string {
  const orderNum = orderName.replace("#", "");
  const safeOrderName = escapeHtml(orderName);

  return `
    <section class="label-page">
      <div class="label-shell bin-label">
        <div class="bin-order">ORDER ${safeOrderName}</div>
        <div class="barcode-wrap">
          <svg
            id="bin-barcode"
            data-barcode-value="${escapeHtml(orderNum)}"
            class="barcode-svg"
          ></svg>
        </div>
      </div>
    </section>
  `;
}

function generateCutLabelHtml(data: PrintData): string {
  const safeTitle = escapeHtml(data.productTitle);
  const safeVariant = escapeHtml(data.variantTitle || "");
  const safeSku = escapeHtml(data.sku || "");
  const safeOrderName = escapeHtml(data.orderName);
  const qtyDisplay = escapeHtml(getQtyDisplay(data.quantity, data.variantTitle));
  const barcode = data.barcode ? escapeHtml(data.barcode) : "";

  return `
    <section class="label-page">
      <div class="label-shell cut-label">
        <div class="product-title">${safeTitle}</div>

        <div class="meta-line">
          ${safeVariant ? `<span>${safeVariant}</span>` : ""}
          ${safeVariant ? `<span class="divider">•</span>` : ""}
          <span>${safeOrderName}</span>
          <span class="divider">•</span>
          <span>${qtyDisplay}</span>
        </div>

        ${
          barcode
            ? `
              <div class="barcode-wrap">
                <svg
                  id="cut-barcode"
                  data-barcode-value="${barcode}"
                  class="barcode-svg"
                ></svg>
              </div>
            `
            : `<div class="no-barcode">NO BARCODE ON FILE</div>`
        }

        <div class="sku-line">SKU: ${safeSku || "-"}</div>
      </div>
    </section>
  `;
}

export default function PrintLabelBothPage() {
  const data = useLoaderData<typeof loader>();

  useEffect(() => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js";

    script.onload = () => {
      const JsBarcode = (window as any).JsBarcode;
      const bin = document.querySelector("#bin-barcode") as SVGElement | null;
      const cut = document.querySelector("#cut-barcode") as SVGElement | null;

      if (bin && JsBarcode) {
        JsBarcode(bin, bin.getAttribute("data-barcode-value"), {
          format: "CODE128",
          displayValue: true,
          textAlign: "center",
          textPosition: "bottom",
          font: "Arial",
          fontOptions: "bold",
          fontSize: 11,
          lineColor: "#000000",
          height: 32,
          margin: 0,
          width: 1.6,
        });
      }

      if (cut && JsBarcode) {
        JsBarcode(cut, cut.getAttribute("data-barcode-value"), {
          format: "CODE128",
          displayValue: false,
          textAlign: "center",
          font: "Arial",
          fontOptions: "bold",
          fontSize: 11,
          lineColor: "#000000",
          height: 30,
          margin: 0,
          width: 1.6,
        });
      }

      setTimeout(() => {
        window.print();
      }, 250);

      window.onafterprint = () => {
        window.close();
      };
    };

    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  const html = `
    ${data.includeBin ? generateBinLabelHtml(data.orderName) : ""}
    ${generateCutLabelHtml(data)}
  `;

  return (
    <html>
      <head>
        <title>Print Labels</title>
        <style>{`
          @page {
            size: 57mm 25mm;
            margin: 0;
          }

          html,
          body {
            margin: 0;
            padding: 0;
            background: #ffffff;
            color: #000000;
            font-family: Arial, Helvetica, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          * {
            box-sizing: border-box;
            color: #000000 !important;
          }

          .label-page {
  width: 57mm;
  height: 25mm;

  display: block;

  page-break-before: always;
  break-before: page;

  page-break-after: always;
  break-after: page;

  overflow: hidden;
}

          .label-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }

          .label-shell {
            width: 57mm;
            height: 25mm;
            padding: 1.5mm 1.8mm;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }

          .label-shell {
  width: 57mm;
  height: 25mm;

  display: flex;
  flex-direction: column;
  justify-content: center;

  transform: scale(1);
  transform-origin: top left;
}

          .bin-label {
            align-items: center;
            text-align: center;
          }

          .bin-order {
            font-size: 11pt;
            font-weight: 900;
            line-height: 1.05;
            margin-bottom: 1.2mm;
            letter-spacing: 0.2px;
          }

          .cut-label {
            align-items: stretch;
            text-align: left;
          }

          .product-title {
            font-size: 7.8pt;
            font-weight: 900;
            line-height: 1.08;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 0.6mm;
          }

          .meta-line {
            display: flex;
            flex-wrap: nowrap;
            align-items: center;
            gap: 0.7mm;
            font-size: 6.2pt;
            font-weight: 700;
            line-height: 1.1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 0.8mm;
          }

          .divider {
            font-weight: 900;
          }

          .barcode-wrap {
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0.4mm 0 0.6mm;
            text-align: center;
          }

          .barcode-svg {
            width: 51.5mm;
            height: auto;
            display: block;
            margin: 0 auto;
          }

          .sku-line {
            text-align: center;
            font-size: 8pt;
            font-weight: 900;
            line-height: 1.05;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 0.3mm;
          }

          .no-barcode {
            text-align: center;
            font-size: 7pt;
            font-weight: 900;
            line-height: 1.1;
            margin: 1.2mm 0 0.8mm;
          }

          @media print {
  html, body {
  width: 57mm;
  height: 25mm;

  margin: 0;
  padding: 0;

  zoom: 1;
}

  body {
    margin: 0;
  }

  .label-page {
    margin: 0;
  }
}
        `}</style>
      </head>
      <body dangerouslySetInnerHTML={{ __html: html }} />
    </html>
  );
}
// @ts-nocheck
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Resource route for all order-tag writes + the cut log. Posting here directly
// (a) avoids the single-fetch 405 you get POSTing to a UI route like /app, and
// (b) lets the client AWAIT each write so same-order writes can be serialized.
// Shopify tag mutations are read-modify-write, so two writes to the same order
// running concurrently clobber each other (lost updates).
const TAGS_ADD = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

const TAGS_REMOVE = `#graphql
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

// Runs a tag mutation and surfaces Shopify userErrors (e.g. the 40-char tag-length
// limit) which otherwise return HTTP 200 and silently drop the write.
async function runTagMutation(
  admin: any,
  mutation: string,
  field: "tagsAdd" | "tagsRemove",
  orderId: string,
  tags: string[],
) {
  const resp = await admin.graphql(mutation, {
    variables: { id: orderId, tags },
  });
  const json = await resp.json();
  const userErrors = json?.data?.[field]?.userErrors ?? [];
  return userErrors as Array<{ field: string; message: string }>;
}

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
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  const orderId = String(formData.get("orderId") || "");
  if (!intent || !orderId) {
    return Response.json({ ok: false }, { status: 400 });
  }

  if (intent === "tagsAdd") {
    const tags = formData.getAll("tags").map(String);
    const errs = await runTagMutation(admin, TAGS_ADD, "tagsAdd", orderId, tags);
    if (errs.length > 0) return Response.json({ ok: false, userErrors: errs }, { status: 422 });
    return Response.json({ ok: true });
  }

  if (intent === "tagsRemove") {
    const tags = formData.getAll("tags").map(String);
    const errs = await runTagMutation(admin, TAGS_REMOVE, "tagsRemove", orderId, tags);
    if (errs.length > 0) return Response.json({ ok: false, userErrors: errs }, { status: 422 });
    return Response.json({ ok: true });
  }

  if (intent === "tagsUpdate") {
    const removeTags = formData.getAll("removeTags").map(String);
    const addTags = formData.getAll("addTags").map(String);
    if (removeTags.length > 0) {
      const errs = await runTagMutation(admin, TAGS_REMOVE, "tagsRemove", orderId, removeTags);
      if (errs.length > 0) return Response.json({ ok: false, userErrors: errs }, { status: 422 });
    }
    if (addTags.length > 0) {
      const errs = await runTagMutation(admin, TAGS_ADD, "tagsAdd", orderId, addTags);
      if (errs.length > 0) return Response.json({ ok: false, userErrors: errs }, { status: 422 });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 400 });
};

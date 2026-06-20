
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate, registerWebhooks } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { seedLatestOrders } from "../lib/sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  await registerWebhooks({ session });
  seedLatestOrders(session.shop, admin).catch((err) =>
    console.error("[Seed] Failed to seed orders on install:", err)
  );

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

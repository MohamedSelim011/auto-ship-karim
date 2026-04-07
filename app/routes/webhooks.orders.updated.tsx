import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} for ${shop}`);

  const order = payload as {
    id: number;
    name: string;
    financial_status: string;
    customer?: { phone?: string };
    shipping_address?: {
      first_name?: string;
      last_name?: string;
      address1?: string;
      city?: string;
      phone?: string;
    };
    line_items: Array<{ title: string; quantity: number }>;
  };

  const shopifyOrderId = `gid://shopify/Order/${order.id}`;

  const existing = await prisma.orderMapping.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
  });

  if (!existing) {
    // Order not tracked in our app — nothing to update
    return new Response(null, { status: 200 });
  }

  const shippingAddress = order.shipping_address;
  const phone = shippingAddress?.phone || order.customer?.phone || "";
  const customerName = [shippingAddress?.first_name, shippingAddress?.last_name]
    .filter(Boolean)
    .join(" ");
  const addressLine = [shippingAddress?.address1, shippingAddress?.city]
    .filter(Boolean)
    .join(", ");

  const isPaidOnline = order.financial_status === "paid";

  await prisma.orderMapping.update({
    where: { id: existing.id },
    data: {
      customerName: customerName || null,
      customerPhone: phone || null,
      shippingAddress: addressLine || null,
      isPaidOnline,
    },
  });

  console.log(`[Webhook] Order ${order.name} details updated`);
  return new Response(null, { status: 200 });
};

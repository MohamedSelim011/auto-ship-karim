import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { QP_STATUS_LABEL, QP_STATUS_TONE } from "../lib/status-mapping";
import { sendOrdersToQP, importHistoricalOrders } from "../lib/sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  // Parse search terms: split by comma or whitespace
  const terms = q
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const orders = await prisma.orderMapping.findMany({
    where: {
      shop: session.shop,
      ...(terms.length > 0
        ? { shopifyOrderNumber: { in: terms.map((t) => (t.startsWith("#") ? t : `#${t}`)) } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return { orders, q };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "send-selected" || intent === "resend-selected") {
    const ids = (formData.get("ids") as string).split(",").filter(Boolean);
    await sendOrdersToQP(session.shop, ids);
    return { sent: true };
  }

  if (intent === "retry-one" || intent === "resend-one") {
    const id = formData.get("id") as string;
    await sendOrdersToQP(session.shop, [id]);
    return { sent: true };
  }

  if (intent === "import-all") {
    const result = await importHistoricalOrders(session.shop);
    return { imported: result.imported };
  }

  return null;
};

type Order = {
  id: string;
  shopifyOrderNumber: string;
  shopifyOrderId: string;
  customerName: string | null;
  customerPhone: string | null;
  shippingAddress: string | null;
  isPaidOnline: boolean;
  qpExpressSerial: string | null;
  qpStatus: string | null;
  syncStatus: string;
  errorMessage: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
};

function syncStatusTone(status: string) {
  if (status === "synced") return "success";
  if (status === "failed") return "critical";
  if (status === "new") return "neutral";
  return "warning";
}

function syncStatusLabel(status: string) {
  if (status === "synced") return "Sent";
  if (status === "failed") return "Failed";
  if (status === "new") return "New";
  return "Pending";
}

export default function Orders() {
  const { orders, q: initialQ } = useLoaderData<{ orders: Order[]; q: string }>();
  const fetcher = useFetcher();
  const importFetcher = useFetcher();
  const navigate = useNavigate();
  const isSubmitting = fetcher.state === "submitting";
  const isImporting = importFetcher.state === "submitting";
  const importResult = importFetcher.data as { imported?: number } | undefined;

  function importAll() {
    const fd = new FormData();
    fd.set("intent", "import-all");
    importFetcher.submit(fd, { method: "post" });
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState(initialQ);

  const failedOrders = orders.filter((o) => o.syncStatus === "failed");
  const allSelectableIds = orders
    .filter((o) => o.syncStatus === "new" || o.syncStatus === "failed" || o.syncStatus === "synced")
    .map((o) => o.id);
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every((id) => selected.has(id));

  const selectedUnsent = orders
    .filter((o) => selected.has(o.id) && (o.syncStatus === "new" || o.syncStatus === "failed"))
    .map((o) => o.id);
  const selectedSent = orders
    .filter((o) => selected.has(o.id) && o.syncStatus === "synced")
    .map((o) => o.id);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allSelectableIds));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function sendSelected() {
    const fd = new FormData();
    fd.set("intent", "send-selected");
    fd.set("ids", selectedUnsent.join(","));
    fetcher.submit(fd, { method: "post" });
    setSelected(new Set());
  }

  function resendSelected() {
    if (!window.confirm(`This will create ${selectedSent.length} new QPExpress shipment(s) with the latest order data. Continue?`)) return;
    const fd = new FormData();
    fd.set("intent", "resend-selected");
    fd.set("ids", selectedSent.join(","));
    fetcher.submit(fd, { method: "post" });
    setSelected(new Set());
  }

  function retryOne(id: string) {
    const fd = new FormData();
    fd.set("intent", "retry-one");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function resendOne(id: string) {
    if (!window.confirm("This will create a new QPExpress shipment with the latest order data. Continue?")) return;
    const fd = new FormData();
    fd.set("intent", "resend-one");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleSearch() {
    const q = searchInput.trim();
    navigate(q ? `/app/orders?q=${encodeURIComponent(q)}` : "/app/orders");
  }

  const showBanner = selected.size > 0 || failedOrders.length > 0;

  return (
    <s-page heading="QPExpress Orders">
      {showBanner && (
        <s-banner tone={selected.size > 0 ? "info" : "warning"}>
          {selected.size > 0 ? (
            <s-stack direction="inline" gap="base">
              <p>{selected.size} order{selected.size > 1 ? "s" : ""} selected</p>
              {selectedUnsent.length > 0 && (
                <s-button variant="primary" loading={isSubmitting} onClick={sendSelected}>
                  Send {selectedUnsent.length > 1 ? `${selectedUnsent.length} Orders` : "Order"} to QPExpress
                </s-button>
              )}
              {selectedSent.length > 0 && (
                <s-button variant="secondary" loading={isSubmitting} onClick={resendSelected}>
                  Resend {selectedSent.length > 1 ? `${selectedSent.length} Orders` : "Order"} to QPExpress
                </s-button>
              )}
              <s-button variant="secondary" onClick={() => setSelected(new Set())}>
                Clear
              </s-button>
            </s-stack>
          ) : (
            <p>{failedOrders.length} order{failedOrders.length > 1 ? "s" : ""} failed to send.</p>
          )}
        </s-banner>
      )}

      <s-section heading={`${orders.length} Orders`}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px", gap: "8px", alignItems: "center" }}>
          {importResult?.imported !== undefined && (
            <span style={{ fontSize: "13px", color: "#108043" }}>
              {importResult.imported} new order{importResult.imported !== 1 ? "s" : ""} imported.
            </span>
          )}
          <s-button variant="secondary" loading={isImporting} onClick={importAll}>
            Import All Historical Orders
          </s-button>
        </div>
        {/* Search bar */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: "8px", marginBottom: "16px" }}
          onKeyUp={(e) => { if (e.key === "Enter") handleSearch(); }}>
          <div style={{ flex: 1 }}>
            <s-text-field
              label="Search orders"
              placeholder="e.g. #1001, #1002 or 1001 1002"
              value={searchInput}
              onInput={(e: Event) => setSearchInput((e.target as HTMLInputElement).value)}
            />
          </div>
          <s-button variant="secondary" onClick={handleSearch}>Search</s-button>
          {initialQ && (
            <s-button variant="secondary" onClick={() => { setSearchInput(""); navigate("/app/orders"); }}>
              Clear
            </s-button>
          )}
        </div>

        {orders.length === 0 ? (
          <s-paragraph>
            {initialQ ? `No orders found for "${initialQ}".` : "No orders yet."}
          </s-paragraph>
        ) : (
          <s-box padding="none" borderWidth="base" borderRadius="base" overflow="hidden">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f6f6f7" }}>
                  <th style={{ ...thStyle, width: 40 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={allSelectableIds.length === 0}
                      title="Select all orders"
                    />
                  </th>
                  <th style={thStyle}>Order</th>
                  <th style={thStyle}>Customer</th>
                  <th style={thStyle}>Address</th>
                  <th style={thStyle}>Payment</th>
                  <th style={thStyle}>QPExpress Serial</th>
                  <th style={thStyle}>Delivery Status</th>
                  <th style={thStyle}>Sync Status</th>
                  <th style={thStyle}>Last Synced</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const isNew = order.syncStatus === "new";
                  const isFailed = order.syncStatus === "failed";
                  const isSynced = order.syncStatus === "synced";
                  const isChecked = selected.has(order.id);
                  return (
                    <tr
                      key={order.id}
                      style={{
                        borderTop: "1px solid #e1e3e5",
                        background: isChecked ? "#f0f7ff" : undefined,
                      }}
                    >
                      <td style={{ ...tdStyle, width: 40 }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleOne(order.id)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <s-link
                          href={`https://admin.shopify.com/orders/${order.shopifyOrderId.split("/").pop()}`}
                          target="_blank"
                        >
                          {order.shopifyOrderNumber}
                        </s-link>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 500 }}>{order.customerName ?? "—"}</div>
                        {order.customerPhone && (
                          <div style={{ fontSize: "12px", color: "#6d7175" }}>{order.customerPhone}</div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 180, color: "#6d7175", fontSize: "13px" }}>
                        {order.shippingAddress ?? "—"}
                      </td>
                      <td style={tdStyle}>
                        <s-badge tone={order.isPaidOnline ? "success" : "neutral"}>
                          {order.isPaidOnline ? "Paid Online" : "COD"}
                        </s-badge>
                      </td>
                      <td style={tdStyle}>
                        {order.qpExpressSerial ?? <span style={{ color: "#8c9196" }}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {order.qpStatus ? (
                          <s-badge tone={(QP_STATUS_TONE[order.qpStatus] ?? "warning") as any}>
                            {QP_STATUS_LABEL[order.qpStatus] ?? order.qpStatus}
                          </s-badge>
                        ) : (
                          <s-badge tone="warning">Pending</s-badge>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <s-badge tone={syncStatusTone(order.syncStatus)}>
                          {syncStatusLabel(order.syncStatus)}
                        </s-badge>
                        {order.errorMessage && (
                          <div
                            style={{ fontSize: "12px", color: "#d82c0d", marginTop: "4px", maxWidth: "180px" }}
                            title={order.errorMessage}
                          >
                            {order.errorMessage.slice(0, 50)}{order.errorMessage.length > 50 ? "…" : ""}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {order.lastSyncedAt
                          ? new Date(order.lastSyncedAt).toLocaleString()
                          : "—"}
                      </td>
                      <td style={tdStyle}>
                        {isFailed && (
                          <s-button variant="secondary" loading={isSubmitting} onClick={() => retryOne(order.id)}>
                            Retry
                          </s-button>
                        )}
                        {isNew && (
                          <s-button
                            variant="primary"
                            loading={isSubmitting}
                            onClick={() => {
                              const fd = new FormData();
                              fd.set("intent", "send-selected");
                              fd.set("ids", order.id);
                              fetcher.submit(fd, { method: "post" });
                            }}
                          >
                            Send
                          </s-button>
                        )}
                        {isSynced && (
                          <s-button variant="secondary" loading={isSubmitting} onClick={() => resendOne(order.id)}>
                            Resend
                          </s-button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: "13px",
  fontWeight: 600,
  color: "#202223",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "14px",
  verticalAlign: "middle",
};

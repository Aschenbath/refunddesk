import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community";
import type { DeskCase, LedgerRow } from "../core/types.js";
import { money, age, parseAmount } from "./api.js";

export const gridTheme = themeQuartz.withParams({
  accentColor: "#1c6259",
  backgroundColor: "#fffefa",
  foregroundColor: "#293c38",
  fontFamily: "Aptos, Segoe UI, sans-serif",
  fontSize: 13,
  headerFontSize: 11,
  headerFontWeight: 600,
  borderColor: "#e4e7df",
  headerBackgroundColor: "#f5f5ef",
  rowBorder: { color: "#eeefe8" },
  rowHeight: 64,
  headerHeight: 43,
  selectedRowBackgroundColor: "#edf5f1",
  rowHoverColor: "#f7f8f2",
  spacing: 8,
  wrapperBorderRadius: 10,
});
export function Chip({
  kind,
  children,
}: {
  kind: string;
  children?: React.ReactNode;
}) {
  return (
    <span className={`chip ${kind}`}>{children || kind.replace("_", " ")}</span>
  );
}
type QueueRow = Partial<DeskCase> & {
  id: string;
  group?: boolean;
  count?: number;
};
export function QueueGrid({
  cases,
  search,
  status,
  grouped,
  onSelect,
  onAmount,
  onInvalidAmount,
}: {
  cases: DeskCase[];
  search: string;
  status: string;
  grouped: boolean;
  onSelect: (id: string) => void;
  onAmount: (id: string, cents: number) => void;
  onInvalidAmount: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const filtered = useMemo(
    () =>
      cases.filter(
        (value) =>
          (status === "all" || status === "review"
            ? status !== "review" ||
              !["refunded", "rejected"].includes(value.status)
            : value.status === status) &&
          `${value.sender} ${value.email} ${value.orderId || ""} ${value.subject} ${value.status} ${value.check?.kind || ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [cases, search, status],
  );
  const rows = useMemo<QueueRow[]>(
    () =>
      grouped
        ? [
            "ready",
            "new",
            "needs_human",
            "failed",
            "processing",
            "pending",
            "refunded",
            "rejected",
          ].flatMap((group) => {
            const members = filtered.filter((value) => value.status === group);
            return members.length
              ? [
                  {
                    id: `group-${group}`,
                    group: true,
                    status: group as DeskCase["status"],
                    count: members.length,
                  },
                  ...(collapsed.has(group) ? [] : members),
                ]
              : [];
          })
        : filtered,
    [filtered, grouped, collapsed],
  );
  const columns = useMemo<ColDef<QueueRow>[]>(
    () => [
      {
        headerName: "Customer",
        field: "sender",
        flex: 1.4,
        minWidth: 165,
        cellRenderer: ({ data }: ICellRendererParams<QueueRow>) => (
          <div className="customer-cell">
            <span className="avatar">
              {data?.sender
                ?.split(" ")
                .map((word) => word[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div>
              <strong>{data?.sender}</strong>
              <small>{data?.subject}</small>
            </div>
          </div>
        ),
      },
      {
        headerName: "Order",
        field: "orderId",
        width: 112,
        cellRenderer: ({ value }: ICellRendererParams) => (
          <span className="order-label">{value || "Unmatched"}</span>
        ),
      },
      {
        headerName: "Intent",
        width: 96,
        valueGetter: (p) => p.data?.proposal?.intent || "—",
        cellRenderer: ({ value }: ICellRendererParams) => (
          <span className="intent">{value}</span>
        ),
      },
      {
        headerName: "Approved amount",
        colId: "amount",
        width: 145,
        type: "numericColumn",
        editable: (p) =>
          !!p.data?.check &&
          !p.data?.attempt &&
          !["refunded", "rejected", "processing", "pending", "failed"].includes(
            p.data.status || "",
          ),
        valueGetter: (p) =>
          p.data?.check ? p.data.check.approvedCents / 100 : null,
        valueFormatter: (p) =>
          p.value === null
            ? "—"
            : money(Math.round(p.value * 100), p.data?.order?.currency),
        cellRenderer: ({ data }: ICellRendererParams<QueueRow>) => (
          <div className="amount-cell">
            <strong>
              {money(data?.check?.approvedCents, data?.order?.currency)}
            </strong>
            {data?.check?.kind === "adjusted" && (
              <small>AI {money(data.check.modelCents)}</small>
            )}
          </div>
        ),
      },
      {
        headerName: "Policy check",
        width: 123,
        valueGetter: (p) => p.data?.check?.kind || "pending",
        cellRenderer: ({ value }: ICellRendererParams) => <Chip kind={value} />,
      },
      {
        headerName: "Confidence",
        width: 106,
        valueGetter: (p) => p.data?.proposal?.confidence,
        cellRenderer: ({ value }: ICellRendererParams) =>
          value === undefined ? (
            "—"
          ) : (
            <span className="confidence">
              <i style={{ width: `${value * 32}px` }} />
              {Math.round(value * 100)}%
            </span>
          ),
      },
      {
        headerName: "Age",
        width: 70,
        valueGetter: (p) => age(p.data?.createdAt),
      },
      {
        headerName: "Status",
        field: "status",
        width: 123,
        cellRenderer: ({ value }: ICellRendererParams) => (
          <Chip kind={value}>
            {value === "needs_human"
              ? "Needs review"
              : value?.replace("_", " ")}
          </Chip>
        ),
      },
    ],
    [],
  );
  return (
    <div className="grid-wrap">
      <AgGridReact<QueueRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: !grouped, resizable: true }}
        rowSelection={{
          mode: "singleRow",
          checkboxes: false,
          enableClickSelection: true,
          isRowSelectable: (node) => !node.data?.group,
        }}
        getRowId={(p) => p.data.id}
        onRowClicked={(p) => {
          if (
            !(p.event?.target as HTMLElement)?.closest('[col-id="amount"]') &&
            p.data &&
            !p.data.group
          )
            onSelect(p.data.id);
        }}
        onCellKeyDown={(p) => {
          if (
            (p.event as KeyboardEvent)?.key === "Enter" &&
            "column" in p &&
            p.column.getColId() !== "amount" &&
            p.data &&
            !p.data.group
          )
            onSelect(p.data.id);
        }}
        readOnlyEdit
        onCellEditRequest={(event) => {
          const cents = parseAmount(String(event.newValue));
          if (event.data && cents !== null) onAmount(event.data.id, cents);
          else onInvalidAmount();
        }}
        isFullWidthRow={(p) => !!p.rowNode.data?.group}
        fullWidthCellRenderer={(p: ICellRendererParams<QueueRow>) => (
          <button
            className="group-row"
            onClick={() =>
              setCollapsed((previous) => {
                const next = new Set(previous);
                next.has(p.data!.status!)
                  ? next.delete(p.data!.status!)
                  : next.add(p.data!.status!);
                return next;
              })
            }
          >
            <span>{collapsed.has(p.data?.status || "") ? "▸" : "▾"}</span>
            {p.data?.status === "needs_human" ? "Needs review" : p.data?.status}
            <span className="count">{p.data?.count}</span>
          </button>
        )}
        getRowHeight={(p) => (p.data?.group ? 38 : 64)}
        getRowClass={(p) =>
          p.data?.status === "refunded" && !p.data?.group ? "row-complete" : ""
        }
        overlayNoRowsTemplate="<div class='grid-empty'><strong>Nothing here right now.</strong><span>Try another filter, or add a customer message.</span></div>"
      />
      <div className="grid-foot">
        <span>
          {filtered.length} {filtered.length === 1 ? "case" : "cases"}
          {status !== "all" || search ? " in this view" : " in your desk"}
        </span>
        <span>Double-click an amount to edit · Select a row to review</span>
      </div>
    </div>
  );
}
export function LedgerGrid({
  rows,
  search,
  onReconcile,
  busy,
}: {
  rows: LedgerRow[];
  search: string;
  onReconcile: (id: string) => void;
  busy: boolean;
}) {
  const columns = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        headerName: "Order / customer",
        field: "orderId",
        flex: 1,
        minWidth: 200,
        cellRenderer: ({ data }: ICellRendererParams<LedgerRow>) => (
          <div className="ledger-customer">
            <strong>{data?.orderId}</strong>
            <small>{data?.customer}</small>
          </div>
        ),
      },
      {
        headerName: "Capture",
        field: "captureId",
        minWidth: 200,
        flex: 1,
        cellRenderer: ({ value }: ICellRendererParams) => <code>{value}</code>,
      },
      ...(["capturedCents", "refundedCents", "netCents"] as const).map(
        (field) => ({
          headerName:
            field === "capturedCents"
              ? "Captured"
              : field === "refundedCents"
                ? "Refunded"
                : "Net",
          field,
          width: 114,
          type: "numericColumn",
          valueFormatter: (p: { value: number; data?: LedgerRow }) =>
            money(p.value, p.data?.currency),
        }),
      ),
      {
        headerName: "Pending",
        field: "pendingCents",
        width: 105,
        type: "numericColumn",
        valueFormatter: (p) => money(p.value, p.data?.currency),
      },
      {
        headerName: "PayPal status",
        field: "paypalStatus",
        width: 173,
        cellRenderer: ({ value }: ICellRendererParams) => (
          <span className="paypal-status">
            {value?.toLowerCase().replaceAll("_", " ")}
          </span>
        ),
      },
      {
        headerName: "Match",
        field: "match",
        width: 153,
        cellRenderer: ({ data }: ICellRendererParams<LedgerRow>) => (
          <Chip
            kind={
              data?.match === true
                ? "pass"
                : data?.unexpectedRefundIds?.length
                  ? "unexpected"
                  : data?.match === false
                    ? "blocked"
                    : "pending"
            }
          >
            {data?.match === true
              ? "✓ Matched"
              : data?.unexpectedRefundIds?.length
                ? "Unexpected refund"
                : data?.match === false
                  ? "Mismatch"
                  : "Unchecked"}
          </Chip>
        ),
      },
      {
        headerName: "Checked",
        field: "checkedAt",
        width: 100,
        valueFormatter: (p) => (p.value ? age(p.value) : "—"),
      },
      {
        headerName: "",
        width: 97,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<LedgerRow>) => (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => data && onReconcile(data.orderId)}
          >
            Check ↻
          </button>
        ),
      },
    ],
    [onReconcile, busy],
  );
  return (
    <div className="grid-wrap">
      <AgGridReact<LedgerRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        quickFilterText={search}
        getRowId={(p) => p.data.orderId}
        getRowClass={(p) =>
          p.data?.match === true && p.data.refundedCents > 0
            ? "row-complete"
            : p.data?.unexpectedRefundIds?.length
              ? "row-unexpected"
              : p.data?.match === false
                ? "row-mismatch"
                : ""
        }
        tooltipShowDelay={200}
        onRowClicked={(p) => {
          if (p.data?.error) alert(p.data.error);
        }}
        overlayNoRowsTemplate="<div class='grid-empty'><strong>No payments yet.</strong><span>Run the sandbox seed to create your first orders.</span></div>"
      />
      <div className="grid-foot">
        <span>{rows.length} orders · Gross amounts, before PayPal fees</span>
        <span>Completed refunds in green · Unexpected refunds in violet</span>
      </div>
    </div>
  );
}

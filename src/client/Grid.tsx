import { useCallback, useMemo, useRef, useState } from "react";
import { AgGridReact, type CustomFilterDisplayProps, type CustomFloatingFilterDisplayProps } from "ag-grid-react";
import {
  ModuleRegistry, ClientSideRowModelModule, ClientSideRowModelApiModule, ColumnApiModule,
  TextFilterModule, NumberFilterModule, CustomFilterModule, QuickFilterModule, CsvExportModule,
  GridStateModule, PinnedRowModule, RowSelectionModule, TextEditorModule, NumberEditorModule,
  RowStyleModule, CellStyleModule, CellApiModule, themeQuartz,
  type ColDef, type GridApi, type GridState, type ICellRendererParams, type DoesFilterPassParams,
} from "ag-grid-community";
import type { DeskCase, LedgerRow } from "../core/types.js";
import { money, age, parseAmount } from "./api.js";
import { caseMoneyTotals, formatMoneyTotals, singleCurrencyCents, sumMoney, type MoneyTotal } from "./money-state.js";
import { Chip } from "./Chip.js";
import { csvCell, selectionSummary, outcomesCsv, type BatchAction, type BatchReport } from "./review-batch.js";
import { memberships, viewNames, presetState, readLayout, writeLayout, clearLayout, matchesFilterModel, type QueueView } from "./grid-state.js";

ModuleRegistry.registerModules([ClientSideRowModelModule, ClientSideRowModelApiModule, ColumnApiModule,
  TextFilterModule, NumberFilterModule, CustomFilterModule, QuickFilterModule, CsvExportModule,
  GridStateModule, PinnedRowModule, RowSelectionModule, TextEditorModule, NumberEditorModule, RowStyleModule, CellStyleModule, CellApiModule]);
const gridTheme = themeQuartz.withParams({ accentColor: "#1c6259", backgroundColor: "#fffefa", foregroundColor: "#293c38",
  fontFamily: "Aptos, Segoe UI, sans-serif", fontSize: 13, headerFontSize: 11, headerFontWeight: 600,
  borderColor: "#e4e7df", headerBackgroundColor: "#f5f5ef", rowBorder: { color: "#eeefe8" },
  rowHeight: 56, headerHeight: 39, selectedRowBackgroundColor: "#edf5f1", rowHoverColor: "#f7f8f2", spacing: 7, wrapperBorderRadius: 10 });
type ChoiceModel = { values: string[] } | null;
function ChoiceFilter({ model, onModelChange, choices }: CustomFilterDisplayProps<unknown, unknown, ChoiceModel> & { choices: string[] }) {
  return <div className="choice-filter"><button className="text-button" onClick={() => onModelChange(null)}>All values</button>
    {choices.map((value) => <label className="check-label" key={value}><input type="checkbox" checked={model?.values.includes(value) ?? false}
      onChange={(event) => { const next = new Set(model?.values || []); event.target.checked ? next.add(value) : next.delete(value); onModelChange(next.size ? { values: [...next] } : null); }} />{value.replaceAll("_", " ")}</label>)}</div>;
}
function ChoiceFloating(props: CustomFloatingFilterDisplayProps & { choices: string[] }) {
  const { model, onModelChange, choices } = props;
  return <select className="choice-floating" aria-label={`${props.column.getColDef().headerName} filter`} value={model?.values?.length === 1 ? model.values[0] : model ? "__multiple" : ""}
    onChange={(event) => onModelChange(event.target.value ? { values: [event.target.value] } : null)}>
    <option value="">All</option>{model?.values?.length > 1 && <option value="__multiple">{model.values.length} selected</option>}
    {choices.map((value) => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>)}</select>;
}
const choiceColumn = (choices: string[]) => ({ filter: { component: ChoiceFilter, doesFilterPass: ({ model, node, handlerParams }: DoesFilterPassParams<unknown, unknown, ChoiceModel>) => !model || model.values.includes(String(handlerParams.getValue(node))) }, filterParams: { choices }, floatingFilterComponent: ChoiceFloating, floatingFilterComponentParams: { choices } });
const defaultColumn: ColDef = { sortable: true, resizable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 75 };
const dollarsForTotals = (totals: MoneyTotal[]) => { const cents = singleCurrencyCents(totals); return cents === null ? null : cents / 100; };
const colId = <T,>(column: ColDef<T>) => column.colId || column.field!;
function baseState<T>(api: GridApi<T>, columns: ColDef<T>[]): GridState {
  return { ...api.getState(), columnOrder: { orderedColIds: columns.map(colId) },
    columnSizing: { columnSizingModel: columns.map((column) => ({ colId: colId(column), width: column.width || 100, flex: column.flex ?? undefined })) },
    columnVisibility: { hiddenColIds: columns.filter((column) => column.hide).map(colId) },
    filter: { filterModel: {} }, sort: { sortModel: [] }, rowSelection: undefined, focusedCell: undefined, scroll: undefined };
}
function useLayout<T>(key: string) {
  const stored = useRef(readLayout(key)), api = useRef<GridApi<T> | null>(null), base = useRef<GridState | null>(null);
  const initial = useRef<GridState | undefined>(stored.current ? { ...stored.current.state, rowSelection: undefined } : undefined);
  const persist = useCallback(() => { if (api.current) writeLayout(key, { ...stored.current, state: api.current.getState() }); }, [key]);
  const reset = () => { clearLayout(key); stored.current = undefined; if (base.current) api.current?.setState(base.current, ["rowSelection"]); };
  return { api, base, initial, stored, persist, reset };
}
function ColumnPicker<T>({ columns, getApi }: { columns: ColDef<T>[]; getApi: () => GridApi<T> | null }) {
  const [, refresh] = useState(0);
  return <details className="column-picker" onToggle={() => refresh((n) => n + 1)}><summary>Columns</summary><div>{columns.filter((column) => !column.suppressColumnsToolPanel).map((column) => {
    const id = colId(column); return <label className="check-label" key={id}><input type="checkbox" checked={getApi()?.getColumn(id)?.isVisible() ?? !column.hide}
      onChange={(event) => { getApi()?.setColumnsVisible([id], event.target.checked); refresh((n) => n + 1); }} />{column.headerName}</label>;
  })}</div></details>;
}
function SearchBox({ search, onSearch, label }: { search: string; onSearch: (value: string) => void; label: string }) {
  return <label className="search-box"><span>⌕</span><input aria-label={`Search ${label}`} placeholder={`Search ${label}…`} value={search} onChange={(event) => onSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => onSearch("")}>×</button>}</label>;
}
const queueAmounts = { modelDollars: "model", allowedDollars: "allowed", approvedDollars: "approved", refundedDollars: "refunded" } as const;
type QueueData = DeskCase & { modelDollars: number | null; allowedDollars: number | null; approvedDollars: number | null; refundedDollars: number | null; amounts: ReturnType<typeof caseMoneyTotals>; workflow: string; summary?: boolean };
export function QueueGrid({ cases, search, onSearch, onSelect, onAmount, onInvalidAmount, onBatch, busy, batchReport }: {
  cases: DeskCase[]; search: string; onSearch: (value: string) => void; onSelect: (id: string) => void; onAmount: (id: string, cents: number) => void; onInvalidAmount: () => void;
  onBatch: (action: BatchAction, ids: string[]) => void; busy: boolean; batchReport: BatchReport | null;
}) {
  const layout = useLayout<QueueData>("refunddesk.queue.v1");
  const [view, setView] = useState<QueueView>(layout.stored.current?.view || "All"), viewRef = useRef(view), [count, setCount] = useState(cases.length);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()), [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const selected = useMemo(() => cases.filter((value) => selectedIds.has(value.id)), [cases, selectedIds]);
  const summary = selectionSummary(selected), hiddenCount = selected.filter((value) => !visibleIds.has(value.id)).length;
  const exportOutcomes = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", outcomesCsv(selected)], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a"); link.href = url; link.download = "refunddesk-outcomes.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rows = useMemo<QueueData[]>(() => cases.map((value) => {
    const amounts = caseMoneyTotals(value);
    return { ...value, amounts, modelDollars: dollarsForTotals(amounts.model), allowedDollars: dollarsForTotals(amounts.allowed),
      approvedDollars: dollarsForTotals(amounts.approved), refundedDollars: dollarsForTotals(amounts.refunded), workflow: memberships(value).join(" | ") };
  }), [cases]);
  const totals = useCallback(() => {
    const api = layout.api.current; if (!api) return;
    const sum = { id: "queue-total", summary: true, sender: "", amounts: { model: [], allowed: [], approved: [], refunded: [] } as QueueData["amounts"] };
    const visible = new Set<string>(), visibleRows: QueueData[] = [];
    api.forEachNodeAfterFilter((node) => { if (node.data) { visible.add(node.data.id); visibleRows.push(node.data); } });
    for (const field of Object.values(queueAmounts)) sum.amounts[field] = sumMoney(visibleRows.flatMap((row) => row.amounts[field]));
    sum.sender = `${visible.size} cases · totals`; setCount(visible.size); setVisibleIds(visible); api.setGridOption("pinnedBottomRowData", [sum as QueueData]);
  }, [layout.api]);
  const columns = useMemo<ColDef<QueueData>[]>(() => [
    { headerName: "Customer", field: "sender", width: 188, minWidth: 188, flex: 1, cellRenderer: ({ data }: ICellRendererParams<QueueData>) => data?.summary ? <strong>{data.sender}</strong> : <div className="customer-cell"><span className="avatar">{data?.sender.split(" ").map((word) => word[0]).slice(0, 2).join("")}</span><div><strong>{data?.sender}</strong><small>{data?.subject}</small></div></div> },
    { headerName: "Order", field: "orderId", width: 105, valueFormatter: (p) => p.node?.rowPinned ? "" : p.value || "Unmatched" },
    { headerName: "Subject", field: "subject", width: 230, hide: true },
    { headerName: "Intent", colId: "intent", width: 100, hide: true, valueGetter: (p) => p.data?.proposal?.intent || "" },
    ...(["modelDollars", "allowedDollars", "approvedDollars", "refundedDollars"] as const).map((field): ColDef<QueueData> => ({
      headerName: { modelDollars: "Model", allowedDollars: "Allowed", approvedDollars: "Approved", refundedDollars: "Refunded" }[field],
      field, colId: field === "approvedDollars" ? "amount" : field, width: field === "approvedDollars" ? 112 : 100, type: "numericColumn", filter: "agNumberColumnFilter",
      wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.4", alignContent: "center" },
      valueFormatter: (p) => p.data ? formatMoneyTotals(p.data.amounts[queueAmounts[field]]) : "—",
      ...(field === "approvedDollars" ? { cellEditor: "agTextCellEditor", editable: (p) => !busy && !p.node.rowPinned && !!p.data?.check && !p.data.attempt && !["refunded", "rejected", "processing", "pending", "failed"].includes(p.data.status) } : {}),
    })),
    { headerName: "Policy check", colId: "policy", width: 124, valueGetter: (p) => p.data?.summary ? "" : p.data?.check?.kind || "pending", ...choiceColumn(["pass", "adjusted", "blocked", "pending"]), cellRenderer: ({ value }: ICellRendererParams) => value ? <Chip kind={value} /> : null },
    { headerName: "Confidence", colId: "confidence", width: 113, filter: "agNumberColumnFilter", valueGetter: (p) => p.data?.proposal?.confidence, valueFormatter: (p) => p.value == null ? "" : `${Math.round(p.value * 100)}%` },
    { headerName: "Status", field: "status", width: 126, ...choiceColumn(["new", "ready", "needs_human", "processing", "pending", "refunded", "rejected", "failed"]), cellRenderer: ({ value }: ICellRendererParams) => value ? <Chip kind={value}>{value === "needs_human" ? "Needs review" : value.replaceAll("_", " ")}</Chip> : null },
    { headerName: "Received", field: "createdAt", width: 100, hide: true, valueFormatter: (p) => age(p.value) },
    { headerName: "Saved view", field: "workflow", hide: true, suppressColumnsToolPanel: true },
  ], [busy]);
  const save = useCallback(() => {
    const api = layout.api.current; if (!api) return;
    const state = { ...api.getState(), rowSelection: undefined };
    layout.stored.current = { state, view: viewRef.current, views: { ...layout.stored.current?.views, [viewRef.current]: state } }; writeLayout("refunddesk.queue.v1", layout.stored.current);
  }, [layout.api, layout.stored]);
  const selectView = (next: QueueView) => {
    save(); viewRef.current = next; setView(next);
    if (layout.base.current) layout.api.current?.setState(layout.stored.current?.views?.[next] || presetState(layout.base.current, next), ["rowSelection"]);
  };
  const viewCount = (name: QueueView) => {
    if (name === view) return count;
    const model = layout.stored.current?.views?.[name]?.filter?.filterModel || (name === "All" ? {} : { workflow: { filterType: "text", type: "contains", filter: name } });
    return rows.filter((row) => matchesFilterModel({ ...row, intent: row.proposal?.intent, policy: row.check?.kind || "pending", confidence: row.proposal?.confidence, amount: row.approvedDollars }, model)).length;
  };
  return <><div className="saved-view-toolbar"><div className="view-tabs" aria-label="Saved queue views">{viewNames.map((name) => <button key={name} aria-pressed={view === name} className={view === name ? "active" : ""} onClick={() => selectView(name)}>{name}<span>{viewCount(name)}</span></button>)}</div>
    <div className="grid-actions"><SearchBox search={search} onSearch={onSearch} label="queue" /><ColumnPicker columns={columns} getApi={() => layout.api.current} /><button className="text-button" onClick={() => { viewRef.current = "All"; setView("All"); layout.reset(); }}>Reset layout</button>
      {!selected.length && <button className="button secondary" onClick={() => layout.api.current?.exportDataAsCsv({ fileName: `refunddesk-${view.toLowerCase().replaceAll(" ", "-")}.csv`, columnKeys: columns.filter((column) => column.field !== "workflow").map(colId), skipPinnedBottom: true, processCellCallback: (p) => csvCell(p.api.getCellValue({ rowNode: p.node!, colKey: p.column, useFormatter: true })) })}>Export view CSV ↓</button>}</div></div>
    <div className="grid-wrap">{!!selected.length && <section className="batch-bar" aria-label="Review batch" aria-busy={busy}>
      <div className="batch-summary" role="status"><strong>{summary.count} selected</strong><span>Model {formatMoneyTotals(summary.modelTotals)}</span><span>Allowed {formatMoneyTotals(summary.allowedTotals)}</span>
        <span>{summary.blocked} blocked · {summary.ready} ready · {summary.refunded} already refunded</span>{hiddenCount > 0 && <span>{hiddenCount} outside this view</span>}</div>
      <div className="batch-actions"><span>Approval stays per case · revision-bound</span><button className="button secondary" disabled={busy} onClick={() => onBatch("triage", selected.map((value) => value.id))}>Triage selected</button>
        <button className="button secondary" disabled={busy} onClick={() => onBatch("reconcile", selected.map((value) => value.id))}>Reconcile selected orders</button>
        <button className="button secondary" disabled={busy} onClick={exportOutcomes}>Export outcomes</button>
        <button className="text-button" disabled={busy} onClick={() => layout.api.current?.deselectAll()}>Clear selection</button></div>
      {batchReport && <details className="batch-report"><summary role="status">{batchReport.summary}</summary>{!!batchReport.details.length && <ul>{batchReport.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}</details>}
    </section>}<AgGridReact<QueueData> enableFilterHandlers theme={gridTheme} rowData={rows} columnDefs={columns} defaultColDef={defaultColumn} initialState={layout.initial.current}
      quickFilterText={search} cacheQuickFilter includeHiddenColumnsInQuickFilter getRowId={(p) => p.data.id}
      onGridReady={(event) => { layout.api.current = event.api; layout.base.current = baseState(event.api, columns); totals(); }} onStateUpdated={save} onGridPreDestroyed={save}
      onFilterChanged={totals} onRowDataUpdated={totals} onCellValueChanged={totals}
      rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !node.rowPinned && !node.data?.summary }}
      selectionColumnDef={{ pinned: "left", lockPosition: true, width: 44, resizable: false }}
      onSelectionChanged={(event) => setSelectedIds(new Set(event.api.getSelectedNodes().map((node) => node.id!)))}
      onRowClicked={(p) => { if (!p.node.rowPinned && p.data && !(p.event?.target as HTMLElement)?.closest('[col-id="amount"], [col-id="ag-Grid-SelectionColumn"]')) onSelect(p.data.id); }}
      onCellKeyDown={(p) => { if ((p.event as KeyboardEvent)?.key === "Enter" && "column" in p && !["amount", "ag-Grid-SelectionColumn"].includes(p.column.getColId()) && !p.node.rowPinned && p.data) onSelect(p.data.id); }}
      readOnlyEdit onCellEditRequest={(event) => { const cents = parseAmount(String(event.newValue)); if (!event.node.rowPinned && cents !== null) onAmount(event.data.id, cents); else onInvalidAmount(); }}
      getRowClass={(p) => p.data?.status === "refunded" ? "row-complete" : ""} overlayNoRowsTemplate="<div class='grid-empty'><strong>No cases match these filters.</strong><span>Choose All or reset the layout.</span></div>" />
      <div className="grid-foot"><span>{count} cases in this view · totals follow every filter</span><span>Double-click Approved to edit · Enter to review</span></div></div></>;
}
type LedgerMoneyField = "capturedDollars" | "refundedDollars" | "netDollars" | "pendingDollars";
type LedgerData = LedgerRow & { capturedDollars: number; refundedDollars: number; netDollars: number; pendingDollars: number; summary?: boolean; totals?: Record<LedgerMoneyField, MoneyTotal[]> };
export function LedgerGrid({ rows, search, onSearch, onReconcile, busy }: { rows: LedgerRow[]; search: string; onSearch: (value: string) => void; onReconcile: (id: string) => void; busy: boolean }) {
  const layout = useLayout<LedgerData>("refunddesk.ledger.v1"), [count, setCount] = useState(rows.length);
  const data = useMemo(() => rows.map((row) => ({ ...row, capturedDollars: row.capturedCents / 100, refundedDollars: row.refundedCents / 100, netDollars: row.netCents / 100, pendingDollars: row.pendingCents / 100 })), [rows]);
  const totals = useCallback(() => {
    const api = layout.api.current; if (!api) return;
    const sum = { orderId: "ledger-total", customer: "", summary: true, totals: { capturedDollars: [], refundedDollars: [], netDollars: [], pendingDollars: [] } as Record<LedgerMoneyField, MoneyTotal[]> };
    const visibleRows: LedgerData[] = []; api.forEachNodeAfterFilter((node) => { if (node.data) visibleRows.push(node.data); });
    const fields = { capturedDollars: "capturedCents", refundedDollars: "refundedCents", netDollars: "netCents", pendingDollars: "pendingCents" } as const;
    for (const field of Object.keys(fields) as LedgerMoneyField[]) sum.totals[field] = sumMoney(visibleRows.map((row) => ({ cents: row[fields[field]], currency: row.currency })));
    const currentCount = visibleRows.length;
    sum.customer = `${currentCount} orders · totals`; setCount(currentCount); api.setGridOption("pinnedBottomRowData", [sum as LedgerData]);
  }, [layout.api]);
  const columns = useMemo<ColDef<LedgerData>[]>(() => [
    { headerName: "Order", field: "orderId", width: 135, valueGetter: (p) => p.data?.summary ? p.data.customer : p.data?.orderId, cellRenderer: ({ value }: ICellRendererParams<LedgerData>) => <strong>{value}</strong> },
    { headerName: "Customer", field: "customer", width: 150, minWidth: 130, flex: 1, valueFormatter: (p) => p.data?.summary ? "" : p.value },
    { headerName: "Capture", field: "captureId", width: 197, cellRenderer: ({ value }: ICellRendererParams) => <code>{value}</code> },
    ...(["capturedDollars", "refundedDollars", "netDollars", "pendingDollars"] as const).map((field): ColDef<LedgerData> => ({
      headerName: { capturedDollars: "Captured", refundedDollars: "Refunded", netDollars: "Net", pendingDollars: "Pending" }[field], field, width: 113, type: "numericColumn", filter: "agNumberColumnFilter",
      wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.4", alignContent: "center" },
      valueFormatter: (p) => p.data?.totals ? formatMoneyTotals(p.data.totals[field]) : money(p.value == null ? p.value : Math.round(p.value * 100), p.data?.currency ?? null),
    })),
    { headerName: "PayPal status", field: "paypalStatus", width: 170, valueFormatter: (p) => p.value?.toLowerCase().replaceAll("_", " ") || "" },
    { headerName: "Match", colId: "match", width: 118, ...choiceColumn(["Matched", "Mismatch", "Unchecked", "Unexpected refund"]), valueGetter: (p) => p.data?.summary ? "" : p.data?.match === true ? "Matched" : p.data?.unexpectedRefundIds?.length ? "Unexpected refund" : p.data?.match === false ? "Mismatch" : "Unchecked", cellRenderer: ({ value }: ICellRendererParams) => value ? <Chip kind={value === "Matched" ? "pass" : "blocked"}>{value}</Chip> : null },
    { headerName: "Checked", field: "checkedAt", width: 98, hide: true, valueFormatter: (p) => age(p.value) },
    { headerName: "Action", colId: "action", width: 82, filter: false, floatingFilter: false, cellRenderer: ({ data }: ICellRendererParams<LedgerData>) => data && !data.summary ? <button className="text-button" disabled={busy} onClick={() => onReconcile(data.orderId)}>Check ↻</button> : null },
  ], [onReconcile, busy]);
  return <><div className="saved-view-toolbar"><strong>Payment records</strong><div className="grid-actions"><SearchBox search={search} onSearch={onSearch} label="ledger" /><ColumnPicker columns={columns} getApi={() => layout.api.current} /><button className="text-button" onClick={layout.reset}>Reset layout</button><button className="button secondary" onClick={() => layout.api.current?.exportDataAsCsv({ fileName: "refunddesk-ledger.csv", skipPinnedBottom: true, columnKeys: columns.filter((column) => column.colId !== "action").map(colId), processCellCallback: (p) => csvCell(p.api.getCellValue({ rowNode: p.node!, colKey: p.column, useFormatter: true })) })}>Export ledger CSV ↓</button></div></div>
    <div className="grid-wrap"><AgGridReact<LedgerData> enableFilterHandlers theme={gridTheme} rowData={data} columnDefs={columns} defaultColDef={defaultColumn} initialState={layout.initial.current} quickFilterText={search} getRowId={(p) => p.data.orderId}
      onGridReady={(event) => { layout.api.current = event.api; layout.base.current = baseState(event.api, columns); totals(); }} onStateUpdated={layout.persist} onGridPreDestroyed={layout.persist} onFilterChanged={totals} onRowDataUpdated={totals}
      getRowClass={(p) => p.data?.summary ? "" : p.data?.unexpectedRefundIds?.length ? "row-unexpected" : p.data?.match === false ? "row-mismatch" : p.data?.refundedCents ? "row-complete" : ""}
      onRowClicked={(p) => { if (p.data?.error && !p.node.rowPinned) alert(p.data.error); }} />
      <div className="grid-foot"><span>{count} orders in this view · gross amounts before PayPal fees</span><span>Filter, verify, export · totals follow filters</span></div></div></>;
}

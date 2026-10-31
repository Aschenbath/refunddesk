import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  emptyFacts,
  type Facts,
  type DeskCase,
  type LedgerRow,
  type Order,
  type Refund,
} from "../core/types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, order_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cases_order ON cases(order_id,status);
      CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, case_id TEXT, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(order_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(case_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS seed_intents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seed_batches(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  reset() {
    this.db.exec(
      "BEGIN; DELETE FROM webhook_events; DELETE FROM attempts; DELETE FROM ledger; DELETE FROM refunds; DELETE FROM cases; DELETE FROM orders; DELETE FROM products; DELETE FROM customers; DELETE FROM policies; COMMIT;",
    );
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private all<T>(table: string): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as T);
  }
  private one<T>(table: string, id: string, key = "id"): T | null {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE ${key}=?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  listOrders(): Order[] {
    return this.all<Order>("orders");
  }
  getOrder(id: string): Order | null {
    return this.one<Order>("orders", id);
  }
  saveOrder(order: Order) {
    const previous = this.getOrder(order.id);
    this.db
      .prepare("INSERT OR REPLACE INTO orders(id,data) VALUES(?,?)")
      .run(order.id, JSON.stringify(order));
    if (previous && JSON.stringify(previous) !== JSON.stringify(order))
      for (const value of this.listCases().filter(
        (value) => value.orderId === order.id,
      ))
        this.saveCase(value, true);
  }
  listCases(): DeskCase[] {
    return this.all<DeskCase>("cases")
      .map((value) => this.normalizeCase(value))
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }
  getCase(id: string): DeskCase | null {
    const value = this.one<DeskCase>("cases", id);
    return value ? this.normalizeCase(value) : null;
  }
  private normalizeCase(value: DeskCase): DeskCase {
    // Existing model-promoted facts are proposals, never migrated into confirmations.
    const legacy = value as DeskCase & {
      facts?: { damagedLineIds: string[]; hasDamageEvidence: boolean };
    };
    const order = value.orderId ? this.getOrder(value.orderId) : null;
    value.revision ??= 1;
    value.proposedFacts ??= {
      ...emptyFacts(),
      damagedItems: (legacy.facts?.damagedLineIds || []).map((item) => ({
        item,
        quantity: order?.lines.find((line) => line.id === item)?.quantity || 1,
      })),
      hasDamageEvidence: legacy.facts?.hasDamageEvidence || false,
    };
    value.confirmedFacts ??= emptyFacts();
    delete legacy.facts;
    return value;
  }
  saveCase(value: DeskCase, forceRevision = false) {
    const { check, order, candidates, refunds, ambiguous, attempt, ...data } =
      value;
    const old = this.getCase(value.id);
    const comparable = (item: object) =>
      JSON.stringify({ ...item, revision: 0 });
    value.revision = old
      ? old.revision +
        (forceRevision || comparable(old) !== comparable(data) ? 1 : 0)
      : 1;
    data.revision = value.revision;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cases(id,order_id,status,data) VALUES(?,?,?,?)",
      )
      .run(value.id, value.orderId, value.status, JSON.stringify(data));
  }
  listRefunds(orderId?: string): Refund[] {
    return this.all<Refund>("refunds").filter(
      (refund) => !orderId || refund.orderId === orderId,
    );
  }
  saveRefund(refund: Refund) {
    this.db
      .prepare(
        "INSERT INTO refunds(id,order_id,case_id,request_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        refund.id,
        refund.orderId,
        refund.caseId,
        refund.requestId,
        JSON.stringify(refund),
      );
  }
  getLedger(id: string): LedgerRow | null {
    return this.one<LedgerRow>("ledger", id, "order_id");
  }
  saveLedger(row: LedgerRow) {
    this.db
      .prepare("INSERT OR REPLACE INTO ledger(order_id,data) VALUES(?,?)")
      .run(row.orderId, JSON.stringify(row));
  }
  lookup(query: {
    email?: string;
    name?: string;
    partialId?: string;
    date?: string;
  }): Order[] {
    const entries = Object.values(query).filter(Boolean);
    if (!entries.length) return [];
    return this.listOrders()
      .filter(
        (order) =>
          (!query.email ||
            order.email.toLowerCase() === query.email.toLowerCase()) &&
          (!query.name ||
            order.customerName
              .toLowerCase()
              .includes(query.name.toLowerCase())) &&
          (!query.partialId ||
            order.id.toLowerCase().includes(query.partialId.toLowerCase())) &&
          (!query.date || order.orderedAt.startsWith(query.date)),
      )
      .slice(0, 30);
  }
  getAttempt(id: string): Attempt | null {
    return this.one<Attempt>("attempts", id, "case_id");
  }
  saveAttempt(attempt: Attempt) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO attempts(case_id,order_id,request_id,data) VALUES(?,?,?,?)",
      )
      .run(
        attempt.caseId,
        attempt.orderId,
        attempt.requestId,
        JSON.stringify(attempt),
      );
  }
  listAttempts(): Attempt[] {
    return this.all<Attempt>("attempts");
  }
  getSeedIntent(id: string): SeedIntent | null {
    return this.one<SeedIntent>("seed_intents", id);
  }
  saveSeedIntent(value: SeedIntent) {
    this.db
      .prepare("INSERT OR REPLACE INTO seed_intents(id,data) VALUES(?,?)")
      .run(value.id, JSON.stringify(value));
  }
  seedBatch(reset = false): { id: string; date: string } {
    if (!reset) {
      const existing = this.one<{ id: string; date: string }>(
        "seed_batches",
        "current",
      );
      if (existing) return existing;
    }
    const batch = {
      id: crypto.randomUUID(),
      date: new Date().toISOString().slice(0, 10),
    };
    this.db
      .prepare(
        "INSERT OR REPLACE INTO seed_batches(id,data) VALUES('current',?)",
      )
      .run(JSON.stringify(batch));
    return batch;
  }
}
export interface Attempt {
  caseId: string;
  orderId: string;
  requestId: string;
  amountCents: number;
  currency: string;
  allocations: { item: string; cents: number }[];
  id: string;
  state: "submitted" | "pending" | "completed" | "failed" | "uncertain";
  createdAt: string;
  revision: number;
  snapshot: {
    revision: number;
    amountCents: number;
    allocations: { item: string; cents: number }[];
    clauseIds: string[];
    facts: Facts;
    order: Order;
    duplicateOverride: string | null;
  };
  refundId?: string;
  checkedAt?: string;
  remoteAbsent?: boolean;
  retryHistory?: { requestId: string; createdAt: string; reason: string }[];
  returnFeeCaseId?: string | null;
}
export interface SeedIntent {
  id: string;
  batch: string;
  kind: "capture" | "refund";
  requestId: string;
  invoiceId: string;
  amountCents: number;
  createdAt: string;
  state: "intent" | "uncertain" | "done";
  paypalOrderId?: string;
  captureId?: string;
  refundId?: string;
  order?: Order;
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DeskCase, LedgerRow, Order, Refund } from "../core/types.js";

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
    this.db
      .prepare("INSERT OR REPLACE INTO orders(id,data) VALUES(?,?)")
      .run(order.id, JSON.stringify(order));
  }
  listCases(): DeskCase[] {
    return this.all<DeskCase>("cases").sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  getCase(id: string): DeskCase | null {
    return this.one<DeskCase>("cases", id);
  }
  saveCase(value: DeskCase) {
    const { check, order, candidates, refunds, ...data } = value;
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
}
export interface Attempt {
  caseId: string;
  orderId: string;
  requestId: string;
  amountCents: number;
  currency: string;
  allocations: { item: string; cents: number }[];
  state: "processing" | "done" | "uncertain";
  createdAt: string;
}

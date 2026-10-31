import { useEffect, useState, useRef } from "react";
import type { DeskCase, Facts } from "../core/types.js";

export function FactConfirmation({
  value,
  disabled,
  onEdit,
}: {
  value: DeskCase;
  disabled: boolean;
  onEdit: (changes: Record<string, unknown>) => Promise<boolean>;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [dates, setDates] = useState({ promisedAt: "", deliveredAt: "" });
  const dirtyDates = useRef(false);
  useEffect(() => {
    dirtyDates.current = false;
  }, [value.id, value.orderId]);
  useEffect(() => {
    const initial: Record<string, number> = {};
    for (const family of ["damagedItems", "returnedItems"] as const)
      for (const line of value.order?.lines || [])
        initial[`${family}:${line.id}`] =
          value.confirmedFacts[family].find((item) => item.item === line.id)
            ?.quantity ||
          value.proposedFacts[family].find((item) => item.item === line.id)
            ?.quantity ||
          1;
    setQuantities(initial);
    if (!dirtyDates.current)
      setDates(
        value.confirmedFacts.deliveryDates ||
          value.proposedFacts.deliveryDates || {
            promisedAt: value.order?.promisedAt || "",
            deliveredAt: value.order?.deliveredAt || "",
          },
      );
  }, [value]);
  const save = (changes: Partial<Facts>) =>
    void onEdit({ confirmedFacts: { ...value.confirmedFacts, ...changes } });
  const clauses = value.proposal?.policy_clause_ids || [];
  const damage = clauses.some((id) => id.startsWith("P1"));
  const returned = clauses.some((id) => id.startsWith("P3"));
  const needsDates = returned || clauses.some((id) => id.startsWith("P2"));
  const family = damage ? "damagedItems" : "returnedItems";
  return (
    <section className="fact-editor" aria-label="Confirm refund facts">
      <div className="section-label">
        Confirm the facts <span>Owner confirmation</span>
      </div>
      <p className="helper">
        Suggestions are prefilled. Check only the facts you have verified; the
        allowance uses your confirmations.
      </p>
      {(damage || returned) &&
        value.order?.lines.map((line) => {
          const item = value.confirmedFacts[family].find(
            (item) => item.item === line.id,
          );
          const proposed = value.proposedFacts[family].find(
            (item) => item.item === line.id,
          );
          const key = `${family}:${line.id}`;
          const quantity = Math.min(
            line.quantity,
            Math.max(1, quantities[key] || 1),
          );
          const change = (enabled: boolean, qty: number) =>
            save({
              [family]: [
                ...value.confirmedFacts[family].filter(
                  (item) => item.item !== line.id,
                ),
                ...(enabled ? [{ item: line.id, quantity: qty }] : []),
              ],
            });
          return (
            <div className="fact-line" key={line.id}>
              <label className="check-label">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!item}
                  onChange={(event) => change(event.target.checked, quantity)}
                />
                <span>
                  {line.title}
                  <small>
                    {damage ? "Damaged units" : "Returned units"} · proposed{" "}
                    {proposed?.quantity || 0} of {line.quantity}
                    {line.sale ? " · Sale item" : ""}
                  </small>
                </span>
              </label>
              <input
                aria-label={`${line.title} ${damage ? "damaged" : "returned"} quantity`}
                type="number"
                min={1}
                max={line.quantity}
                step={1}
                value={quantity}
                disabled={disabled}
                onChange={(event) => {
                  const next = Math.min(
                    line.quantity,
                    Math.max(1, Math.floor(Number(event.target.value) || 1)),
                  );
                  setQuantities((previous) => ({ ...previous, [key]: next }));
                  if (item) change(true, next);
                }}
              />
            </div>
          );
        })}
      {damage && (
        <label className="check-label">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.confirmedFacts.hasDamageEvidence}
            onChange={(event) =>
              save({ hasDamageEvidence: event.target.checked })
            }
          />
          Photo or clear damage description verified
        </label>
      )}
      {returned && (
        <label className="check-label">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.confirmedFacts.returnReceived}
            onChange={(event) => save({ returnReceived: event.target.checked })}
          />
          I verified this return was received · $6 fee for this case
        </label>
      )}
      {needsDates && (
        <>
          <div className="form-pair">
            <label>
              Promised date
              <input
                type="date"
                disabled={disabled}
                value={dates.promisedAt}
                onChange={(event) => {
                  dirtyDates.current = true;
                  setDates({ ...dates, promisedAt: event.target.value });
                  if (value.confirmedFacts.deliveryDates)
                    save({ deliveryDates: null });
                }}
              />
            </label>
            <label>
              Delivered date
              <input
                type="date"
                disabled={disabled}
                value={dates.deliveredAt}
                onChange={(event) => {
                  dirtyDates.current = true;
                  setDates({ ...dates, deliveredAt: event.target.value });
                  if (value.confirmedFacts.deliveryDates)
                    save({ deliveryDates: null });
                }}
              />
            </label>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              disabled={disabled || !dates.promisedAt || !dates.deliveredAt}
              checked={!!value.confirmedFacts.deliveryDates}
              onChange={(event) => {
                dirtyDates.current = false;
                save({ deliveryDates: event.target.checked ? dates : null });
              }}
            />
            I verified these delivery dates
          </label>
        </>
      )}
    </section>
  );
}

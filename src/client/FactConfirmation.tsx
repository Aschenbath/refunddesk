import { useEffect, useState } from "react";
import type { DeskCase, Facts } from "../core/types.js";

export function FactConfirmation({
  value,
  disabled,
  onEdit,
  onPendingChange,
}: {
  value: DeskCase;
  disabled: boolean;
  onEdit: (changes: Record<string, unknown>) => Promise<boolean>;
  onPendingChange: (pending: boolean) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const identity = `${value.id}:${value.orderId}`;
  type Dates = NonNullable<Facts["deliveryDates"]>;
  const [dateDraft, setDateDraft] = useState<{ identity: string; dates: Dates } | null>(null);
  const [dateError, setDateError] = useState<{ identity: string; message: string } | null>(null);
  const [savingDates, setSavingDates] = useState(false);
  const draft = dateDraft?.identity === identity ? dateDraft : null;
  const dates = draft?.dates || value.confirmedFacts.deliveryDates || value.proposedFacts.deliveryDates || {
    promisedAt: value.order?.promisedAt || "", deliveredAt: value.order?.deliveredAt || "",
  };
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
  }, [value]);
  const save = (changes: Partial<Facts>) =>
    void onEdit({ confirmedFacts: { ...value.confirmedFacts, ...changes } });
  const clauses = value.proposal?.policy_clause_ids || [];
  const damage = clauses.some((id) => id.startsWith("P1"));
  const returned = clauses.some((id) => id.startsWith("P3"));
  const needsDates = returned || clauses.some((id) => id.startsWith("P2"));
  const family = damage ? "damagedItems" : "returnedItems";
  useEffect(() => {
    onPendingChange(needsDates && !!draft);
    return () => onPendingChange(false);
  }, [needsDates, draft, onPendingChange]);
  const editDate = (field: keyof Dates, next: string) => {
    setDateDraft({ identity, dates: { ...dates, [field]: next } });
    setDateError(null);
    onPendingChange(true);
  };
  const confirmDates = async (confirmed: boolean) => {
    if (disabled || savingDates) return;
    setDateDraft({ identity, dates });
    setSavingDates(true);
    setDateError(null);
    onPendingChange(true);
    try {
      const saved = await onEdit({ confirmedFacts: { ...value.confirmedFacts, deliveryDates: confirmed ? dates : null } });
      if (!saved) throw new Error("Dates were not saved");
      setDateDraft((current) => current?.identity === identity ? null : current);
    } catch {
      setDateError({ identity, message: "Delivery dates were not confirmed. Your edits are kept; confirm them again before approving." });
    } finally {
      setSavingDates(false);
    }
  };
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
                disabled={disabled || savingDates}
                value={dates.promisedAt}
                onChange={(event) => editDate("promisedAt", event.target.value)}
              />
            </label>
            <label>
              Delivered date
              <input
                type="date"
                disabled={disabled || savingDates}
                value={dates.deliveredAt}
                onChange={(event) => editDate("deliveredAt", event.target.value)}
              />
            </label>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              disabled={disabled || savingDates || !dates.promisedAt || !dates.deliveredAt}
              checked={!draft && !!value.confirmedFacts.deliveryDates}
              onChange={(event) => void confirmDates(event.target.checked)}
            />
            I verified these delivery dates
          </label>
          {draft && <p className="helper">Confirm these dates to save them and recalculate the allowance before approving.</p>}
          {dateError?.identity === identity && <p className="field-error" role="alert">{dateError.message}</p>}
        </>
      )}
    </section>
  );
}

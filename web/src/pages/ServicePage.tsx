import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useLoadedMeta } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { MoneyInput, Status } from "../components/ui";
import { fmtDateTime, fmtMoney } from "../lib/format";
import { serviceTotals } from "../../../shared/service";
import type { ServiceLine, ServiceOrder } from "../../../shared/types";

const STATUSES: [ServiceOrder["status"], string][] = [
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["waiting_parts", "Waiting parts"],
  ["done", "Work done"],
];

export function ServicePage() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["service-order", id], queryFn: () => api<ServiceOrder>(`/service/${id}`) });
  if (q.isPending) return <div className="wrap muted">Loading…</div>;
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  return <Editor key={q.data.version} order={q.data} />;
}

function Editor({ order }: { order: ServiceOrder }) {
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const s = meta.settings;
  const [f, setF] = useState({ status: order.status, complaint: order.complaint, technician: order.technician, notes: order.notes });
  const [lines, setLines] = useState<ServiceLine[]>(order.lines);
  const internal = !!order.stockVehicleId;
  const locked = order.status === "closed" || order.status === "cancelled";
  const t = serviceTotals(lines, s, internal);
  const done = (o: ServiceOrder) => {
    qc.setQueryData(["service-order", order.id], o);
    void qc.invalidateQueries({ queryKey: ["service"] });
  };
  const save = useMutation({ mutationFn: () => api<ServiceOrder>(`/service/${order.id}`, { method: "PUT", body: { ...f, lines, version: order.version } }), onSuccess: done });
  const close = useMutation({ mutationFn: () => api<ServiceOrder>(`/service/${order.id}/close`, { method: "POST", body: { version: order.version } }), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api<ServiceOrder>(`/service/${order.id}/cancel`, { method: "POST", body: { version: order.version } }), onSuccess: done });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const dirty = JSON.stringify(lines) !== JSON.stringify(order.lines) || f.status !== order.status || f.complaint !== order.complaint || f.technician !== order.technician || f.notes !== order.notes;
  const setLine = (i: number, patch: Partial<ServiceLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const err = save.error ?? close.error ?? cancel.error;
  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <Link to="/service" className="small">
            ← Service
          </Link>
          <h1>
            {order.number} · {order.vehicleDesc}
          </h1>
          <div className="muted small">
            {internal ? (
              <>
                Reconditioning <Link to={`/inventory/${order.stockVehicleId}`}>{order.stockVehicleLabel}</Link>
              </>
            ) : (
              <>
                For <Link to={`/customers/${order.customerId}`}>{order.customerName}</Link>
                {order.plate && ` · ${order.plate}`}
              </>
            )}
            {" · "}opened {fmtDateTime(order.createdAt)}
            {order.invoiceNo && ` · invoice ${order.invoiceNo}`}
          </div>
        </div>
        <span className="spacer" />
        <Status value={order.status} kind="service" />
        {order.invoiceNo && (
          <Link className="btn" to={`/service/${order.id}/print`} target="_blank">
            Print invoice
          </Link>
        )}
      </div>
      <div className="worksheet">
        <div className="stack">
          <section className="card stack">
            <div className="form-grid three">
              <label>
                Status
                <select value={f.status} disabled={locked} onChange={(e) => setF({ ...f, status: e.target.value as ServiceOrder["status"] })}>
                  {(locked ? [[order.status, order.status]] : STATUSES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Technician
                <input value={f.technician} disabled={locked} onChange={(e) => setF({ ...f, technician: e.target.value })} />
              </label>
              <label className="span3">
                Work requested
                <textarea rows={2} value={f.complaint} disabled={locked} onChange={(e) => setF({ ...f, complaint: e.target.value })} />
                {errs.complaint && <div className="field-error">{errs.complaint}</div>}
              </label>
            </div>
          </section>
          <section className="card stack" aria-label="Labour and parts">
            <h2>Labour and parts</h2>
            {lines.map((l, i) => (
              <div key={i} className="service-line">
                <select value={l.kind} disabled={locked} onChange={(e) => setLine(i, { kind: e.target.value as ServiceLine["kind"] })} aria-label="Line type">
                  <option value="labour">Labour</option>
                  <option value="part">Part</option>
                </select>
                <input value={l.description} disabled={locked} placeholder="Description" aria-label="Description" onChange={(e) => setLine(i, { description: e.target.value })} />
                <input
                  inputMode="decimal"
                  value={String(l.quantity)}
                  disabled={locked}
                  aria-label={l.kind === "labour" ? "Hours" : "Quantity"}
                  onChange={(e) => setLine(i, { quantity: Number(e.target.value) || 0 })}
                />
                <MoneyInput label={l.kind === "labour" ? "Rate" : "Unit price"} cents={l.unitCents} disabled={locked} onChange={(c) => setLine(i, { unitCents: c })} />
                <span className="r">{fmtMoney(t.lineTotal(l))}</span>
                {!locked && (
                  <button type="button" className="btn btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">
                    ✕
                  </button>
                )}
              </div>
            ))}
            {Object.entries(errs)
              .filter(([k]) => k.startsWith("lines"))
              .slice(0, 1)
              .map(([k, m]) => (
                <div key={k} className="field-error">
                  Line {Number(k.split(".")[1]) + 1}: {m}
                </div>
              ))}
            {!locked && (
              <div className="row" style={{ marginBottom: 0 }}>
                <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { kind: "labour", description: "", quantity: 1, unitCents: s.labourRateCents }])}>
                  + Labour
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { kind: "part", description: "", quantity: 1, unitCents: 0 }])}>
                  + Part
                </button>
              </div>
            )}
          </section>
          <label>
            Internal notes
            <textarea rows={2} value={f.notes} disabled={locked} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
        </div>
        <aside className="card stack summary" aria-label="Order total">
          <h2>Total</h2>
          <dl className="totals">
            <dt>Subtotal</dt>
            <dd>{fmtMoney(t.subtotalCents)}</dd>
            <dt>Tax{internal ? " (none: internal)" : ` (${s.taxPercent}%${s.partsTaxable ? "" : ", labour only"})`}</dt>
            <dd>{fmtMoney(t.taxCents)}</dd>
            <dt className="grand">Total</dt>
            <dd className="grand" data-testid="service-total">
              {fmtMoney(t.totalCents)}
            </dd>
          </dl>
          {internal && <p className="muted small">When closed, {fmtMoney(t.subtotalCents)} is added to the car's cost.</p>}
        </aside>
      </div>
      {err && (
        <div className="notice" role="alert">
          {errorText(err)}
        </div>
      )}
      {!locked && (
        <div className="btn-row" style={{ justifyContent: "flex-start" }}>
          <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            className="btn"
            disabled={dirty || order.status !== "done" || close.isPending}
            title={order.status !== "done" ? "Set the status to Work done and save first" : dirty ? "Save your changes first" : undefined}
            onClick={() => {
              if (window.confirm(internal ? "Close the order and add its cost to the car?" : "Close the order and issue the invoice? It can't be edited afterwards.")) close.mutate();
            }}
          >
            {internal ? "Close and post cost" : "Close and invoice"}
          </button>
          <button
            className="btn btn-danger"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm("Cancel this order?")) cancel.mutate();
            }}
          >
            Cancel order
          </button>
        </div>
      )}
    </div>
  );
}

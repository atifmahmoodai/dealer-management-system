import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { can, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { DocumentsPanel, Status } from "../components/ui";
import { fmtDate, fmtMoney0, SOURCE_LABEL } from "../lib/format";
import type { Customer, Deal, Lead, ServiceOrder } from "../../../shared/types";

interface Detail {
  customer: Customer;
  leads: Lead[];
  deals: Deal[];
  service: ServiceOrder[];
}

export function CustomerPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const role = me.data?.role;
  const q = useQuery({ queryKey: ["customer", id], queryFn: () => api<Detail>(`/customers/${id}`) });
  if (q.isPending) return <div className="wrap muted">Loading…</div>;
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  const { customer: c, leads, deals, service } = q.data;
  const spent = deals.filter((d) => d.status === "closed").reduce((s, d) => s + d.totals.totalCents, 0);
  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <Link to="/customers" className="small">
            ← Customers
          </Link>
          <h1>{c.name}</h1>
          <div className="muted small">
            Customer since {fmtDate(c.createdAt)} · {deals.filter((d) => d.status === "closed").length} cars bought{spent ? ` (${fmtMoney0(spent)})` : ""}
          </div>
        </div>
        <span className="spacer" />
        {can.sell(role) && (
          <Link className="btn btn-primary" to={`/deals/new?customer=${c.id}`}>
            Start a deal
          </Link>
        )}
        {can.service(role) && (
          <Link className="btn" to={`/service?new=1&customer=${c.id}`}>
            New service order
          </Link>
        )}
      </div>
      <div className="grid2">
        <EditCustomer key={c.id} customer={c} onSaved={() => void q.refetch()} />
        <section className="card stack">
          <h2>History</h2>
          {can.sell(role) && (
            <>
              <h3>Deals</h3>
              <ul className="plain-list">
                {deals.map((d) => (
                  <li key={d.id}>
                    <Link to={`/deals/${d.id}`}>{d.number ?? "Deal"}</Link> · {d.vehicleLabel} · <Status value={d.status} kind="deal" /> · {fmtMoney0(d.totals.totalCents)}
                  </li>
                ))}
                {deals.length === 0 && <li className="muted small">None.</li>}
              </ul>
              <h3>Leads</h3>
              <ul className="plain-list">
                {leads.map((l) => (
                  <li key={l.id}>
                    {l.vehicleLabel ?? l.interest ?? "General enquiry"} · {SOURCE_LABEL[l.source]} · <Status value={l.status} /> · <span className="muted small">{fmtDate(l.createdAt)}</span>
                  </li>
                ))}
                {leads.length === 0 && <li className="muted small">None.</li>}
              </ul>
            </>
          )}
          {can.service(role) && (
            <>
              <h3>Service</h3>
              <ul className="plain-list">
                {service.map((s) => (
                  <li key={s.id}>
                    <Link to={`/service/${s.id}`}>{s.number}</Link> · {s.vehicleDesc} · <Status value={s.status} kind="service" /> · {fmtMoney0(s.totalCents)}
                  </li>
                ))}
                {service.length === 0 && <li className="muted small">None.</li>}
              </ul>
            </>
          )}
        </section>
      </div>
      <DocumentsPanel entity="customer" entityId={c.id} />
    </div>
  );
}

function EditCustomer({ customer, onSaved }: { customer: Customer; onSaved: () => void }) {
  const [f, setF] = useState({ kind: customer.kind, name: customer.name, email: customer.email ?? "", phone: customer.phone, address: customer.address, notes: customer.notes });
  const save = useMutation({ mutationFn: () => api(`/customers/${customer.id}`, { method: "PUT", body: f }), onSuccess: onSaved });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string) => {
    save.reset();
    setF((x) => ({ ...x, [k]: v }));
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-label="Customer details">
      <h2>Details</h2>
      <div className="form-grid">
        <label>
          Name
          <input value={f.name} onChange={(e) => set("name", e.target.value)} />
          {errs.name && <div className="field-error">{errs.name}</div>}
        </label>
        <label>
          Type
          <select value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            <option value="person">Person</option>
            <option value="company">Company</option>
          </select>
        </label>
        <label>
          Phone
          <input type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
          {errs.phone && <div className="field-error">{errs.phone}</div>}
        </label>
        <label>
          Email
          <input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
          {errs.email && <div className="field-error">{errs.email}</div>}
        </label>
        <label className="span2">
          Address
          <input value={f.address} onChange={(e) => set("address", e.target.value)} />
        </label>
        <label className="span2">
          Notes
          <textarea rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
      {save.isError && !Object.keys(errs).length && <div className="field-error">{errorText(save.error)}</div>}
      {save.isSuccess && <div className="notice notice-good" role="status">Saved.</div>}
      <div>
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          Save
        </button>
      </div>
    </form>
  );
}

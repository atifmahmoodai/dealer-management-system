import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { CustomerPicker, Modal, Status, VehiclePicker } from "../components/ui";
import { fmtDateTime, fromLocalInput, LEAD_STATUS_LABEL, SOURCE_LABEL, toLocalInput } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";
import type { Activity, Customer, Lead, Vehicle } from "../../../shared/types";

const STAGES = ["new", "contacted", "appointment", "negotiation"] as const;
const SOURCES = Object.keys(SOURCE_LABEL);
const ACTIVITY_LABEL: Record<string, string> = { call: "Call", email: "Email", sms: "Text", meeting: "Meeting", test_drive: "Test drive", note: "Note" };

export function Leads() {
  const [params, setParams] = useSearchParams();
  const mine = params.get("mine") === "1";
  const overdue = params.get("overdue") === "1";
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(params.get("new") === "1");
  const list = useQuery({
    queryKey: ["leads", mine, overdue, dq],
    queryFn: () => api<{ items: Lead[] }>(`/leads?${new URLSearchParams({ status: "open", mine: mine ? "1" : "", overdue: overdue ? "1" : "", q: dq })}`),
    placeholderData: keepPreviousData,
  });
  const toggle = (k: string, on: boolean) => {
    const p = new URLSearchParams(params);
    if (on) p.set(k, "1");
    else p.delete(k);
    p.delete("new");
    setParams(p, { replace: true });
  };
  const now = Date.now();
  const items = list.data?.items ?? [];
  return (
    <div className="wrap wide">
      <div className="page-head">
        <h1>Leads</h1>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + New lead
        </button>
      </div>
      <div className="filters">
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => toggle("mine", e.target.checked)} /> Only mine
        </label>
        <label className="check">
          <input type="checkbox" checked={overdue} onChange={(e) => toggle("overdue", e.target.checked)} /> Overdue follow-ups
        </label>
        <label className="grow">
          Search
          <input type="search" placeholder="Name, phone, email or interest…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {list.isError && <div className="notice">{errorText(list.error)}</div>}
      <div className="board">
        {STAGES.map((s) => {
          const col = items.filter((l) => l.status === s);
          return (
            <section key={s} className="board-col" aria-label={LEAD_STATUS_LABEL[s]}>
              <h2>
                {LEAD_STATUS_LABEL[s]} <span className="badge">{col.length}</span>
              </h2>
              {col.map((l) => {
                const late = l.nextFollowUpAt && Date.parse(l.nextFollowUpAt) < now;
                return (
                  <button key={l.id} className={`lead-card ${late ? "late" : ""}`} onClick={() => setOpen(l.id)}>
                    <strong>{l.customerName}</strong>
                    <span className="small">{l.vehicleLabel ?? l.interest ?? ""}</span>
                    <span className="muted small">
                      {SOURCE_LABEL[l.source]} · {l.assignedName ?? "unassigned"}
                    </span>
                    {l.nextFollowUpAt && <span className={`small ${late ? "late-text" : "muted"}`}>{late ? "⚠ follow up was due " : "Follow up "}{fmtDateTime(l.nextFollowUpAt)}</span>}
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      {open && <LeadDialog id={open} onClose={() => setOpen(null)} />}
      {adding && (
        <NewLead
          onClose={() => {
            setAdding(false);
            toggle("new", false);
          }}
          onCreated={(id) => {
            setAdding(false);
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewLead({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [f, setF] = useState({ source: "walk_in", interest: "", followUp: toLocalInput(new Date(Date.now() + 86_400_000).toISOString()) });
  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/leads", {
        method: "POST",
        body: { customerId: customer?.id ?? "", vehicleId: vehicle?.id ?? null, source: f.source, interest: f.interest, assignedTo: null, nextFollowUpAt: f.followUp ? fromLocalInput(f.followUp) : null },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["leads"] });
      onCreated(r.id);
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Modal title="New lead" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <div>
          <div className="label">Customer</div>
          <CustomerPicker value={customer} onPick={setCustomer} />
          {errs.customerId && <div className="field-error">Choose or add the customer.</div>}
        </div>
        <div>
          <div className="label">Car of interest (optional)</div>
          <VehiclePicker value={vehicle} onPick={setVehicle} />
        </div>
        <div className="form-grid">
          <label>
            Source
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Follow up
            <input type="datetime-local" value={f.followUp} onChange={(e) => setF({ ...f, followUp: e.target.value })} />
          </label>
          <label className="span2">
            Looking for
            <input value={f.interest} placeholder="e.g. family SUV under 25k, needs finance" onChange={(e) => setF({ ...f, interest: e.target.value })} />
          </label>
        </div>
        {save.isError && <div className="field-error">{errorText(save.error)}</div>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !customer}>
            {save.isPending ? "Saving…" : "Create lead"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LeadDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const meta = useLoadedMeta();
  const me = useMe();
  const q = useQuery({ queryKey: ["lead", id], queryFn: () => api<{ lead: Lead; activities: Activity[] }>(`/leads/${id}`) });
  if (q.isPending) return <Modal title="Lead" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  if (q.isError) return <Modal title="Lead" onClose={onClose}><div className="notice">{errorText(q.error)}</div></Modal>;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["lead", id] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
  };
  const { lead, activities } = q.data;
  const salesStaff = meta.users.filter((u) => u.role !== "service");
  return (
    <Modal title={lead.customerName} onClose={onClose} wide>
      <div className="small">
        <Link to={`/customers/${lead.customerId}`}>Customer record</Link>
        {lead.customerPhone && (
          <>
            {" · "}
            <a href={`tel:${lead.customerPhone.replace(/[^\d+]/g, "")}`}>{lead.customerPhone}</a>
          </>
        )}
        {lead.customerEmail && (
          <>
            {" · "}
            <a href={`mailto:${lead.customerEmail}`}>{lead.customerEmail}</a>
          </>
        )}
        {" · "}
        {SOURCE_LABEL[lead.source]} · since {fmtDateTime(lead.createdAt)}
      </div>
      {lead.vehicleLabel && (
        <div className="small">
          Interested in <Link to={`/inventory/${lead.vehicleId}`}>{lead.vehicleLabel}</Link>
        </div>
      )}
      <LeadEdit key={lead.version} lead={lead} staff={salesStaff} onSaved={refresh} />
      <div className="row" style={{ marginBottom: 0 }}>
        {lead.status !== "won" && lead.status !== "lost" && (
          <Link className="btn btn-primary btn-sm" to={`/deals/new?customer=${lead.customerId}${lead.vehicleId ? `&vehicle=${lead.vehicleId}` : ""}&lead=${lead.id}`}>
            Start a deal
          </Link>
        )}
        <span className="muted small">Assigned to {lead.assignedName ?? "nobody"}{lead.assignedTo === me.data?.id ? " (you)" : ""}</span>
      </div>
      <LogActivity leadId={lead.id} onSaved={refresh} />
      <ul className="timeline">
        {activities.map((a) => (
          <li key={a.id}>
            <strong>{ACTIVITY_LABEL[a.type] ?? a.type}</strong> <span className="muted small">{fmtDateTime(a.at)} · {a.byName}</span>
            <div>{a.body}</div>
          </li>
        ))}
        {activities.length === 0 && <li className="muted small">No contact logged yet.</li>}
      </ul>
    </Modal>
  );
}

function LeadEdit({ lead, staff, onSaved }: { lead: Lead; staff: { id: string; name: string }[]; onSaved: () => void }) {
  const [f, setF] = useState({ status: lead.status, assignedTo: lead.assignedTo ?? "", followUp: toLocalInput(lead.nextFollowUpAt), lostReason: lead.lostReason, interest: lead.interest });
  const save = useMutation({
    mutationFn: () =>
      api<Lead>(`/leads/${lead.id}`, {
        method: "PUT",
        body: {
          vehicleId: lead.vehicleId,
          source: lead.source,
          interest: f.interest,
          assignedTo: f.assignedTo || null,
          nextFollowUpAt: f.followUp ? fromLocalInput(f.followUp) : null,
          status: f.status,
          lostReason: f.lostReason,
          version: lead.version,
        },
      }),
    onSuccess: onSaved,
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  return (
    <form
      className="form-grid three"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      noValidate
      aria-label="Lead details"
    >
      <label>
        Stage
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Lead["status"] })}>
          {["new", "contacted", "appointment", "negotiation", "won", "lost"].map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Assigned to
        <select value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
          <option value="">Nobody</option>
          {staff.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Next follow-up
        <input type="datetime-local" value={f.followUp} disabled={f.status === "won" || f.status === "lost"} onChange={(e) => setF({ ...f, followUp: e.target.value })} />
      </label>
      {f.status === "lost" && (
        <label className="span3">
          Why was it lost?
          <input value={f.lostReason} onChange={(e) => setF({ ...f, lostReason: e.target.value })} placeholder="Bought elsewhere, price, finance declined…" />
          {errs.lostReason && <div className="field-error">{errs.lostReason}</div>}
        </label>
      )}
      <label className="span3">
        Looking for
        <input value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} />
      </label>
      <div className="span3 row" style={{ marginBottom: 0 }}>
        <button className="btn btn-sm" type="submit" disabled={save.isPending}>
          Save lead
        </button>
        {save.isSuccess && <span className="small" role="status">Saved.</span>}
        {save.isError && <span className="field-error">{errorText(save.error)}</span>}
        <Status value={lead.status} />
      </div>
    </form>
  );
}

function LogActivity({ leadId, onSaved }: { leadId: string; onSaved: () => void }) {
  const [type, setType] = useState("call");
  const [body, setBody] = useState("");
  const save = useMutation({
    mutationFn: () => api(`/leads/${leadId}/activities`, { method: "POST", body: { type, body } }),
    onSuccess: () => {
      setBody("");
      onSaved();
    },
  });
  return (
    <form
      className="log-activity"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      noValidate
      aria-label="Log contact"
    >
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Contact type">
        {Object.entries(ACTIVITY_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened?" aria-label="What happened" />
      <button className="btn btn-sm" type="submit" disabled={save.isPending || !body.trim()}>
        Log
      </button>
      {save.isError && <span className="field-error">{errorText(save.error)}</span>}
    </form>
  );
}

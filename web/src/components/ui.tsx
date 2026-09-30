import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorText } from "../api/client";
import { centsToInput, DEAL_STATUS_LABEL, fmtDateTime, LEAD_STATUS_LABEL, parseMoney, SERVICE_STATUS_LABEL, VEHICLE_STATUS_LABEL } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";
import type { Customer, DocumentMeta, Vehicle } from "../../../shared/types";

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "warn" }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  in_stock: "badge-good",
  reserved: "badge-warn",
  sold: "",
  new: "badge-brand",
  contacted: "",
  appointment: "badge-warn",
  negotiation: "badge-warn",
  won: "badge-good",
  lost: "",
  draft: "",
  pending_approval: "badge-warn",
  approved: "badge-brand",
  closed: "badge-good",
  cancelled: "",
  open: "badge-brand",
  in_progress: "badge-warn",
  waiting_parts: "badge-warn",
  done: "badge-good",
};
const LABELS = { ...VEHICLE_STATUS_LABEL, ...LEAD_STATUS_LABEL, ...DEAL_STATUS_LABEL, ...SERVICE_STATUS_LABEL };
export function Status({ value, kind }: { value: string; kind?: "service" | "deal" }) {
  const label = kind === "service" ? SERVICE_STATUS_LABEL[value] : kind === "deal" ? DEAL_STATUS_LABEL[value] : LABELS[value as keyof typeof LABELS];
  return <span className={`badge ${TONES[value] ?? ""}`}>{label ?? value}</span>;
}

/** Amount field that keeps what the user typed and reports cents (NaN while it isn't a valid amount). */
export function MoneyInput({ label, cents, onChange, error, disabled }: { label: string; cents: number; onChange: (c: number) => void; error?: string; disabled?: boolean }) {
  const [text, setText] = useState(() => (Number.isFinite(cents) ? centsToInput(cents) : ""));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : Number.isFinite(cents) ? centsToInput(cents) : text;
  const bad = shown.trim() !== "" && Number.isNaN(parseMoney(shown));
  return (
    <label>
      {label}
      <input
        inputMode="decimal"
        value={shown}
        disabled={disabled}
        aria-invalid={bad || !!error}
        onFocus={() => {
          setText(shown);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim() === "" ? 0 : parseMoney(e.target.value));
        }}
      />
      {(bad || error) && <div className="field-error">{bad ? "Enter an amount like 1250 or 1250.50" : error}</div>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`card modal stack ${wide ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 0 }}>
          <h2>{title}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/** Files attached to a customer, vehicle or deal (PDF or photos, up to 5 MB each). */
export function DocumentsPanel({ entity, entityId, canEdit = true }: { entity: "customer" | "vehicle" | "deal"; entityId: string; canEdit?: boolean }) {
  const qc = useQueryClient();
  const key = ["documents", entity, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: DocumentMeta[] }>(`/documents?entity=${entity}&entityId=${encodeURIComponent(entityId)}`) });
  const file = useRef<HTMLInputElement>(null);
  const [tooBig, setTooBig] = useState(false);
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append("entity", entity);
      form.append("entityId", entityId);
      form.append("file", f);
      return api("/documents", { method: "POST", form });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/documents/${id}`, { method: "DELETE" }), onSuccess: () => void qc.invalidateQueries({ queryKey: key }) });
  return (
    <section className="card stack" aria-label="Documents">
      <div className="row" style={{ marginBottom: 0 }}>
        <h2>Documents</h2>
        <span className="spacer" />
        {canEdit && (
          <>
            <button className="btn btn-sm" disabled={upload.isPending} onClick={() => file.current?.click()}>
              {upload.isPending ? "Uploading…" : "+ Upload"}
            </button>
            <input
              ref={file}
              type="file"
              hidden
              accept="application/pdf,image/jpeg,image/png,image/webp"
              aria-label="Upload a document"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setTooBig(f.size > 5 * 1024 * 1024);
                if (f.size <= 5 * 1024 * 1024) upload.mutate(f);
              }}
            />
          </>
        )}
      </div>
      {tooBig && <div className="field-error">Files can be at most 5 MB.</div>}
      {(upload.isError || remove.isError) && <div className="field-error">{errorText(upload.error ?? remove.error)}</div>}
      {q.data?.items.length === 0 && <p className="muted small">No files yet. Add ID, licence, title, invoices or photos (PDF, JPEG, PNG).</p>}
      <ul className="doc-list">
        {q.data?.items.map((d) => (
          <li key={d.id}>
            <a href={`/api/documents/${d.id}/download`}>{d.filename}</a>
            <span className="muted small">
              {size(d.size)} · {d.uploadedBy ?? "?"} · {fmtDateTime(d.uploadedAt)}
            </span>
            {canEdit && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (window.confirm(`Delete ${d.filename}?`)) remove.mutate(d.id);
                }}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Find a customer, or add one on the spot. */
export function CustomerPicker({ value, onPick }: { value: Customer | null; onPick: (c: Customer | null) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [adding, setAdding] = useState(false);
  const results = useQuery({ queryKey: ["customer-search", dq], enabled: dq.length >= 2, queryFn: () => api<{ items: Customer[] }>(`/customers?q=${encodeURIComponent(dq)}`) });
  if (value) {
    return (
      <div className="picked">
        <span>
          <strong>{value.name}</strong> <span className="muted small">{value.phone || value.email}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={() => onPick(null)}>
          Change
        </button>
      </div>
    );
  }
  if (adding) return <NewCustomerForm initialName={q} onCancel={() => setAdding(false)} onCreated={onPick} />;
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <input type="search" placeholder="Search customers by name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      {dq.length >= 2 && (
        <ul className="pick-list">
          {results.data?.items.slice(0, 8).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onPick(c)}>
                <strong>{c.name}</strong> <span className="muted small">{c.phone || c.email}</span>
              </button>
            </li>
          ))}
          {results.data?.items.length === 0 && <li className="muted small">No match.</li>}
        </ul>
      )}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
          + New customer
        </button>
      </div>
    </div>
  );
}

export function NewCustomerForm({ initialName = "", onCreated, onCancel }: { initialName?: string; onCreated: (c: Customer) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: initialName, email: "", phone: "", address: "" });
  const save = useMutation({
    mutationFn: () => api<Customer>("/customers", { method: "POST", body: { kind: "person", ...f, notes: "" } }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["customers"] });
      onCreated(c);
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    save.mutate();
  }
  return (
    <div className="card sub-card stack" role="group" aria-label="New customer">
      <div className="form-grid">
        <label>
          Name
          <input value={f.name} onChange={(e) => set("name", e.target.value)} />
          {errs.name && <div className="field-error">{errs.name}</div>}
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
        <label>
          Address
          <input value={f.address} onChange={(e) => set("address", e.target.value)} />
        </label>
      </div>
      {save.isError && !Object.keys(errs).length && <div className="field-error">{errorText(save.error)}</div>}
      <div className="btn-row" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending} onClick={submit}>
          {save.isPending ? "Saving…" : "Add customer"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** Find a car in stock by stock number, VIN or name. */
export function VehiclePicker({ value, onPick, status = "available" }: { value: Vehicle | null; onPick: (v: Vehicle | null) => void; status?: string }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const results = useQuery({ queryKey: ["vehicle-search", dq, status], enabled: dq.length >= 1, queryFn: () => api<{ items: Vehicle[] }>(`/vehicles?status=${status}&q=${encodeURIComponent(dq)}`) });
  if (value) {
    return (
      <div className="picked">
        <span>
          <strong>
            {value.year} {value.make} {value.model} {value.trim}
          </strong>{" "}
          <span className="muted small">stock {value.stockNo}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={() => onPick(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <input type="search" placeholder="Stock number, VIN or model…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vehicles" />
      {dq && (
        <ul className="pick-list">
          {results.data?.items.slice(0, 8).map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => onPick(v)}>
                <strong>
                  {v.year} {v.make} {v.model} {v.trim}
                </strong>{" "}
                <span className="muted small">
                  {v.stockNo} · {VEHICLE_STATUS_LABEL[v.status]}
                </span>
              </button>
            </li>
          ))}
          {results.data?.items.length === 0 && <li className="muted small">No match in stock.</li>}
        </ul>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { isAdmin, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { MoneyInput } from "../components/ui";
import { fmtMoney } from "../lib/format";
import type { Role } from "../../../shared/schemas";
import type { Branch, Settings as AppSettings } from "../../../shared/types";

export function Settings() {
  const me = useMe();
  const meta = useLoadedMeta();
  if (!isAdmin(me.data)) return <Navigate to="/" replace />;
  return (
    <div className="wrap narrow">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <SettingsForm initial={meta.settings} />
      <Branches branches={meta.branches} />
      <Users />
    </div>
  );
}

function SettingsForm({ initial }: { initial: AppSettings }) {
  const qc = useQueryClient();
  const [s, setS] = useState(initial);
  const [taxText, setTaxText] = useState(String(initial.taxPercent));
  const save = useMutation({
    mutationFn: () => api<AppSettings>("/settings", { method: "PUT", body: { ...s, taxPercent: Number(taxText), currency: s.currency.trim().toUpperCase(), locale: s.locale.trim() } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["meta"] }),
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    save.reset();
    setS((x) => ({ ...x, [k]: v }));
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-label="Business settings">
      <h2>Business rules</h2>
      <div className="form-grid">
        <label>
          Company name
          <input value={s.companyName} onChange={(e) => set("companyName", e.target.value)} />
          {errs.companyName && <div className="field-error">{errs.companyName}</div>}
        </label>
        <label>
          Currency / locale
          <span className="row" style={{ margin: 0, flexWrap: "nowrap" }}>
            <input aria-label="Currency" value={s.currency} onChange={(e) => set("currency", e.target.value)} style={{ minWidth: 0 }} />
            <input aria-label="Locale" value={s.locale} onChange={(e) => set("locale", e.target.value)} style={{ minWidth: 0 }} />
          </span>
          {(errs.currency || errs.locale) && <div className="field-error">{errs.currency ?? errs.locale}</div>}
        </label>
        <label>
          Sales tax %
          <input inputMode="decimal" value={taxText} onChange={(e) => setTaxText(e.target.value)} />
          {errs.taxPercent && <div className="field-error">{errs.taxPercent}</div>}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.taxTradeInCredit} onChange={(e) => set("taxTradeInCredit", e.target.checked)} /> Tax only the difference after a trade-in
        </label>
        <MoneyInput label="Documentation fee" cents={s.docFeeCents} onChange={(c) => set("docFeeCents", c)} error={errs.docFeeCents} />
        <MoneyInput label="Minimum gross without approval" cents={s.minGrossCents} onChange={(c) => set("minGrossCents", c)} error={errs.minGrossCents} />
        <MoneyInput label="Labour rate (per hour)" cents={s.labourRateCents} onChange={(c) => set("labourRateCents", c)} error={errs.labourRateCents} />
        <label className="check">
          <input type="checkbox" checked={s.partsTaxable} onChange={(e) => set("partsTaxable", e.target.checked)} /> Parts are taxable
        </label>
        <label>
          Mileage unit
          <select value={s.distanceUnit} onChange={(e) => set("distanceUnit", e.target.value as AppSettings["distanceUnit"])}>
            <option value="mi">Miles</option>
            <option value="km">Kilometres</option>
          </select>
        </label>
      </div>
      <h3>F&amp;I products</h3>
      <p className="muted small">What salespeople can add to a deal. The cost is used for back-end gross; salespeople can't change it.</p>
      {s.products.map((p, i) => (
        <div key={i} className="addon-row">
          <input aria-label="Product name" value={p.description} onChange={(e) => set("products", s.products.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
          <MoneyInput label="Price" cents={p.priceCents} onChange={(c) => set("products", s.products.map((x, j) => (j === i ? { ...x, priceCents: c } : x)))} />
          <MoneyInput label="Cost" cents={p.costCents} onChange={(c) => set("products", s.products.map((x, j) => (j === i ? { ...x, costCents: c } : x)))} />
          <button type="button" className="btn btn-sm" onClick={() => set("products", s.products.filter((_, j) => j !== i))} aria-label={`Remove ${p.description}`}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => set("products", [...s.products, { description: "", priceCents: 0, costCents: 0 }])}>
          + Product
        </button>
      </div>
      {save.isError && <div className="field-error">{errorText(save.error)}</div>}
      {save.isSuccess && (
        <div className="notice notice-good" role="status">
          Saved. Deals already closed keep their numbers; open deals use the new rules (minimum gross {fmtMoney(s.minGrossCents)}).
        </div>
      )}
      <div>
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

function Branches({ branches }: { branches: Branch[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Branch | "new" | null>(null);
  const [f, setF] = useState({ name: "", address: "", phone: "" });
  const save = useMutation({
    mutationFn: () => (editing === "new" ? api("/branches", { method: "POST", body: f }) : api(`/branches/${(editing as Branch).id}`, { method: "PUT", body: f })),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["meta"] });
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  return (
    <section className="card stack" aria-label="Branches">
      <div className="row" style={{ marginBottom: 0 }}>
        <h2>Branches</h2>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          onClick={() => {
            setF({ name: "", address: "", phone: "" });
            setEditing("new");
          }}
        >
          + Branch
        </button>
      </div>
      {branches.map((b) => (
        <div key={b.id} className="row" style={{ justifyContent: "space-between", marginBottom: 0 }}>
          <span>
            <strong>{b.name}</strong> <span className="muted small">{b.address} · {b.phone}</span>
          </span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setF({ name: b.name, address: b.address, phone: b.phone });
              setEditing(b);
            }}
          >
            Edit
          </button>
        </div>
      ))}
      {editing && (
        <form
          className="form-grid three"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          noValidate
        >
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            {errs.name && <div className="field-error">{errs.name}</div>}
          </label>
          <label>
            Address
            <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </label>
          <label>
            Phone
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </label>
          <div className="span3 row" style={{ marginBottom: 0 }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={save.isPending}>
              Save branch
            </button>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  branchId: string | null;
  active: boolean;
  locked: boolean;
}

const ROLE_LABELS: { id: Role; label: string }[] = [
  { id: "sales", label: "Sales (leads, customers, deals; no costs)" },
  { id: "service", label: "Service (repair orders, customers)" },
  { id: "manager", label: "Manager (everything above, stock, costs, approvals, reports)" },
  { id: "admin", label: "Admin (also settings, branches, users)" },
];

function Users() {
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ items: StaffUser[] }>("/users") });
  const [editing, setEditing] = useState<StaffUser | "new" | null>(null);
  return (
    <section className="card stack" style={{ marginTop: "1rem" }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Staff logins</h2>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
          + Add user
        </button>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      {q.data?.items.map((u) => (
        <div key={u.id} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <strong>{u.name}</strong> <span className="muted small">{u.email} · {u.role}{u.branchId ? ` · ${meta.branches.find((b) => b.id === u.branchId)?.name ?? ""}` : ""}</span>{" "}
            {!u.active ? <span className="badge">Disabled</span> : u.locked ? <span className="badge badge-bad">Locked</span> : null}
          </span>
          <button className="btn btn-sm" onClick={() => setEditing(u)}>
            Edit
          </button>
        </div>
      ))}
      {editing && <UserDialog user={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ["users"] })} />}
    </section>
  );
}

function UserDialog({ user, onClose, onSaved }: { user: StaffUser | null; onClose: () => void; onSaved: () => void }) {
  const meta = useLoadedMeta();
  const [f, setF] = useState({ name: user?.name ?? "", email: user?.email ?? "", role: user?.role ?? ("sales" as Role), active: user?.active ?? true, password: "", branchId: user?.branchId ?? "" });
  const [done, setDone] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      if (!user) return api("/users", { method: "POST", body: { email: f.email, name: f.name, role: f.role, branchId: f.branchId || null, password: f.password } });
      await api(`/users/${user.id}`, { method: "PUT", body: { name: f.name, role: f.role, branchId: f.branchId || null, active: f.active } });
      if (f.password) await api(`/users/${user.id}/password`, { method: "POST", body: { password: f.password } });
    },
    onSuccess: () => {
      onSaved();
      if (user && f.password) setDone("Saved. The new password is active and their other sessions were signed out.");
      else onClose();
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={user ? "Edit user" : "Add user"} onClick={onClose}>
      <form
        className="card modal stack"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        noValidate
      >
        <h2 style={{ margin: 0 }}>{user ? `Edit ${user.name}` : "Add user"}</h2>
        <label>
          Name
          <input value={f.name} onChange={(e) => set("name", e.target.value)} />
          {errs.name && <div className="field-error">{errs.name}</div>}
        </label>
        <label>
          Email
          <input type="email" value={f.email} disabled={!!user} onChange={(e) => set("email", e.target.value)} />
          {errs.email && <div className="field-error">{errs.email}</div>}
        </label>
        <label>
          Role
          <select value={f.role} onChange={(e) => set("role", e.target.value)}>
            {ROLE_LABELS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Branch
          <select value={f.branchId} onChange={(e) => set("branchId", e.target.value)}>
            <option value="">No branch</option>
            {meta.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {user ? "New password (leave blank to keep)" : "Password"}
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
          <span className="muted small">At least 10 characters with letters and a number.</span>
          {errs.password && <div className="field-error">{errs.password}</div>}
        </label>
        {user && (
          <label style={{ display: "flex", alignItems: "center" }}>
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (untick when someone leaves)
          </label>
        )}
        {save.isError && !Object.keys(errs).length && <div className="field-error">{errorText(save.error)}</div>}
        {done && <div className="notice notice-good">{done}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

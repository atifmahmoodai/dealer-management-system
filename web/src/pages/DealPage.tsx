import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { CustomerPicker, DocumentsPanel, MoneyInput, Status, VehiclePicker } from "../components/ui";
import { fmtDateTime, fmtMoney, fmtNum } from "../lib/format";
import { dealGross, dealTotals, type Worksheet } from "../../../shared/deal";
import type { Customer, Deal, Settings, Vehicle } from "../../../shared/types";

export function DealPage() {
  const { id = "" } = useParams();
  return id === "new" ? <NewDeal /> : <ExistingDeal id={id} />;
}

const blankWorksheet = (v: Vehicle | null, s: Settings): Worksheet => ({
  salePriceCents: v?.listPriceCents ?? 0,
  discountCents: 0,
  docFeeCents: s.docFeeCents,
  addOns: [],
  tradeIn: null,
  depositCents: 0,
  finance: null,
});

function NewDeal() {
  const [params] = useSearchParams();
  const meta = useLoadedMeta();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [w, setW] = useState<Worksheet | null>(null);
  const vid = params.get("vehicle");
  const cid = params.get("customer");
  // Preselected from a vehicle, customer or lead page.
  useQuery({
    queryKey: ["prefill-vehicle", vid],
    enabled: !!vid,
    queryFn: async () => {
      const r = await api<{ vehicle: Vehicle }>(`/vehicles/${vid}`);
      setVehicle((cur) => cur ?? r.vehicle);
      setW((cur) => cur ?? blankWorksheet(r.vehicle, meta.settings));
      return r.vehicle;
    },
  });
  useQuery({
    queryKey: ["prefill-customer", cid],
    enabled: !!cid,
    queryFn: async () => {
      const r = await api<{ customer: Customer }>(`/customers/${cid}`);
      setCustomer((cur) => cur ?? r.customer);
      return r.customer;
    },
  });
  const create = useMutation({
    mutationFn: () => api<Deal>("/deals", { method: "POST", body: { customerId: customer!.id, vehicleId: vehicle!.id, leadId: params.get("lead"), worksheet: w } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ["deals"] });
      nav(`/deals/${d.id}`, { replace: true });
    },
  });
  const errs = create.error instanceof ApiError ? create.error.details : {};
  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <Link to="/deals" className="small">
            ← Deals
          </Link>
          <h1>New deal</h1>
        </div>
      </div>
      <div className="grid2">
        <section className="card stack">
          <h2>Customer</h2>
          <CustomerPicker value={customer} onPick={setCustomer} />
        </section>
        <section className="card stack">
          <h2>Vehicle</h2>
          <VehiclePicker
            value={vehicle}
            onPick={(v) => {
              setVehicle(v);
              setW(v ? blankWorksheet(v, meta.settings) : null);
            }}
          />
        </section>
      </div>
      {vehicle && w && (
        <WorksheetEditor w={w} onChange={setW} settings={meta.settings} seeCost={can.seeCost(me.data?.role)} vehicleCostCents={vehicle.totalCostCents} errors={errs} />
      )}
      {create.isError && <div className="notice" role="alert">{errorText(create.error)}</div>}
      <div>
        <button className="btn btn-primary" disabled={!customer || !vehicle || !w || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create deal"}
        </button>
      </div>
    </div>
  );
}

function ExistingDeal({ id }: { id: string }) {
  const me = useMe();
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const role = me.data?.role;
  const q = useQuery({ queryKey: ["deal", id], queryFn: () => api<Deal>(`/deals/${id}`) });
  const vehicleQ = useQuery({
    queryKey: ["vehicle", q.data?.vehicleId],
    enabled: !!q.data && can.seeCost(role),
    queryFn: () => api<{ vehicle: Vehicle }>(`/vehicles/${q.data!.vehicleId}`),
  });
  const [draft, setDraft] = useState<{ version: number; w: Worksheet; notes: string } | null>(null);
  const deal = q.data;
  // Start editing from the server's copy; a new version from the server replaces an untouched draft.
  const current = deal && (!draft || draft.version !== deal.version) ? { version: deal.version, w: deal.worksheet, notes: deal.notes } : draft;
  const dirty = !!deal && !!draft && draft.version === deal.version && (JSON.stringify(draft.w) !== JSON.stringify(deal.worksheet) || draft.notes !== deal.notes);
  const onDone = (d: Deal) => {
    qc.setQueryData(["deal", id], d);
    setDraft(null);
    void qc.invalidateQueries({ queryKey: ["deals"] });
    void qc.invalidateQueries({ queryKey: ["vehicles"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const save = useMutation({ mutationFn: () => api<Deal>(`/deals/${id}`, { method: "PUT", body: { worksheet: current!.w, notes: current!.notes, version: deal!.version } }), onSuccess: onDone });
  const action = useMutation({
    mutationFn: ({ name, reason }: { name: string; reason?: string }) => api<Deal>(`/deals/${id}/${name}`, { method: "POST", body: { version: deal!.version, reason: reason ?? "" } }),
    onSuccess: onDone,
  });
  if (q.isPending) return <div className="wrap muted">Loading…</div>;
  if (q.isError || !deal || !current) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  const editable = ["draft", "pending_approval", "approved"].includes(deal.status) && can.sell(role);
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const err = save.error ?? action.error;
  const ask = (name: string, question: string, required: boolean) => {
    const reason = window.prompt(question);
    if (reason === null || (required && !reason.trim())) return;
    action.mutate({ name, reason });
  };
  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <Link to="/deals" className="small">
            ← Deals
          </Link>
          <h1>
            {deal.number ?? "Deal"} · {deal.customerName}
          </h1>
          <div className="muted small">
            <Link to={`/inventory/${deal.vehicleId}`}>
              {deal.vehicleLabel} ({deal.stockNo})
            </Link>{" "}
            · <Link to={`/customers/${deal.customerId}`}>customer record</Link> · {deal.salespersonName ?? "no salesperson"} · started {fmtDateTime(deal.createdAt)}
            {deal.approvedByName && <> · approved by {deal.approvedByName}</>}
          </div>
        </div>
        <span className="spacer" />
        <Status value={deal.status} kind="deal" />
        {deal.status === "closed" && (
          <Link className="btn" to={`/deals/${deal.id}/print`} target="_blank">
            Print bill of sale
          </Link>
        )}
      </div>

      {deal.status === "pending_approval" && (
        <div className="notice" role="status">
          This deal is below the minimum gross of {fmtMoney(meta.settings.minGrossCents)}, so a manager must approve it before it can close.
        </div>
      )}
      {deal.notes && <div className="card small pre">{deal.notes}</div>}

      <WorksheetEditor
        w={current.w}
        onChange={(w) => setDraft({ version: deal.version, w, notes: current.notes })}
        settings={meta.settings}
        seeCost={can.seeCost(role)}
        vehicleCostCents={deal.status === "closed" ? undefined : vehicleQ.data?.vehicle.totalCostCents}
        frozen={deal.status === "closed" ? deal : undefined}
        disabled={!editable}
        errors={errs}
      />

      {editable && (
        <label>
          Notes
          <textarea rows={2} value={current.notes} onChange={(e) => setDraft({ version: deal.version, w: current.w, notes: e.target.value })} />
        </label>
      )}
      {err && (
        <div className="notice" role="alert">
          {errorText(err)}
        </div>
      )}
      <div className="btn-row" style={{ justifyContent: "flex-start" }}>
        {editable && (
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : deal.status === "draft" ? "Save" : "Save changes (back to draft)"}
          </button>
        )}
        {deal.status === "draft" && can.sell(role) && (
          <button className="btn btn-primary" disabled={dirty || action.isPending} title={dirty ? "Save your changes first" : undefined} onClick={() => action.mutate({ name: "submit" })}>
            Submit deal
          </button>
        )}
        {deal.status === "pending_approval" && can.approve(role) && (
          <>
            <button className="btn btn-primary" disabled={dirty || action.isPending} onClick={() => action.mutate({ name: "approve" })}>
              Approve
            </button>
            <button className="btn" disabled={action.isPending} onClick={() => ask("reject", "Why send it back? (the salesperson sees this)", true)}>
              Send back
            </button>
          </>
        )}
        {deal.status === "approved" && can.sell(role) && (
          <button
            className="btn btn-primary"
            disabled={dirty || action.isPending}
            onClick={() => {
              if (window.confirm(`Close the deal? The car is marked sold${deal.worksheet.tradeIn ? ", the trade-in goes into stock" : ""} and an invoice number is issued. This can't be undone.`)) action.mutate({ name: "close" });
            }}
          >
            Close deal (sold)
          </button>
        )}
        {["draft", "pending_approval", "approved"].includes(deal.status) && can.sell(role) && (
          <button className="btn btn-danger" disabled={action.isPending} onClick={() => ask("cancel", "Cancel this deal? Say why (optional).", false)}>
            Cancel deal
          </button>
        )}
      </div>
      {deal.status !== "cancelled" && <DocumentsPanel entity="deal" entityId={deal.id} canEdit={can.sell(role)} />}
    </div>
  );
}

const TERMS = [24, 36, 48, 60, 72, 84];

/** The pricing worksheet with a live summary. Gross is shown only to people who may see costs. */
export function WorksheetEditor({
  w,
  onChange,
  settings,
  seeCost,
  vehicleCostCents,
  frozen,
  disabled,
  errors = {},
}: {
  w: Worksheet;
  onChange: (w: Worksheet) => void;
  settings: Settings;
  seeCost: boolean;
  vehicleCostCents?: number;
  frozen?: Deal;
  disabled?: boolean;
  errors?: Record<string, string>;
}) {
  const t = frozen ? frozen.totals : dealTotals(w, settings);
  const gross = frozen ? frozen.gross : vehicleCostCents !== undefined ? dealGross(w, vehicleCostCents) : undefined;
  const set = (patch: Partial<Worksheet>) => onChange({ ...w, ...patch });
  const e = (k: string) => errors[`worksheet.${k}`];
  const [product, setProduct] = useState("");
  return (
    <div className="worksheet">
      <div className="stack">
        <section className="card stack" aria-label="Price">
          <h2>Price</h2>
          <div className="form-grid three">
            <MoneyInput label="Selling price" cents={w.salePriceCents} onChange={(c) => set({ salePriceCents: c })} disabled={disabled} error={e("salePriceCents")} />
            <MoneyInput label="Discount" cents={w.discountCents} onChange={(c) => set({ discountCents: c })} disabled={disabled} error={e("discountCents")} />
            <MoneyInput label="Documentation fee" cents={w.docFeeCents} onChange={(c) => set({ docFeeCents: c })} disabled={disabled} />
          </div>
        </section>

        <section className="card stack" aria-label="Add-ons">
          <h2>Add-ons</h2>
          {w.addOns.map((a, i) => (
            <div key={i} className="addon-row">
              <span>{a.description}</span>
              <MoneyInput label="Price" cents={a.priceCents} disabled={disabled} onChange={(c) => set({ addOns: w.addOns.map((x, j) => (j === i ? { ...x, priceCents: c } : x)) })} />
              {seeCost && <MoneyInput label="Cost" cents={a.costCents} disabled={disabled} onChange={(c) => set({ addOns: w.addOns.map((x, j) => (j === i ? { ...x, costCents: c } : x)) })} />}
              {!disabled && (
                <button type="button" className="btn btn-sm" onClick={() => set({ addOns: w.addOns.filter((_, j) => j !== i) })} aria-label={`Remove ${a.description}`}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {e("addOns") && <div className="field-error">{e("addOns")}</div>}
          {!disabled && (
            <div className="row" style={{ marginBottom: 0 }}>
              <select value={product} onChange={(ev) => setProduct(ev.target.value)} aria-label="Product to add">
                <option value="">Choose a product…</option>
                {settings.products
                  .filter((p) => !w.addOns.some((a) => a.description === p.description))
                  .map((p) => (
                    <option key={p.description} value={p.description}>
                      {p.description} ({fmtMoney(p.priceCents)})
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!product}
                onClick={() => {
                  const p = settings.products.find((x) => x.description === product)!;
                  set({ addOns: [...w.addOns, { ...p }] });
                  setProduct("");
                }}
              >
                + Add
              </button>
            </div>
          )}
        </section>

        <section className="card stack" aria-label="Trade-in">
          <label className="check">
            <input
              type="checkbox"
              checked={!!w.tradeIn}
              disabled={disabled}
              onChange={(ev) => set({ tradeIn: ev.target.checked ? { vin: "", year: new Date().getFullYear() - 8, make: "", model: "", mileage: 0, allowanceCents: 0, acvCents: 0, payoffCents: 0 } : null })}
            />{" "}
            <strong>Customer is trading in a car</strong>
          </label>
          {w.tradeIn && (
            <div className="form-grid three">
              {(["make", "model"] as const).map((k) => (
                <label key={k}>
                  {k === "make" ? "Make" : "Model"}
                  <input value={w.tradeIn![k]} disabled={disabled} onChange={(ev) => set({ tradeIn: { ...w.tradeIn!, [k]: ev.target.value } })} />
                  {e(`tradeIn.${k}`) && <div className="field-error">{e(`tradeIn.${k}`)}</div>}
                </label>
              ))}
              <label>
                Year
                <input inputMode="numeric" value={String(w.tradeIn.year)} disabled={disabled} onChange={(ev) => set({ tradeIn: { ...w.tradeIn!, year: Number(ev.target.value) || 0 } })} />
              </label>
              <label>
                VIN
                <input value={w.tradeIn.vin} disabled={disabled} onChange={(ev) => set({ tradeIn: { ...w.tradeIn!, vin: ev.target.value.toUpperCase() } })} />
                {e("tradeIn.vin") && <div className="field-error">{e("tradeIn.vin")}</div>}
              </label>
              <label>
                Mileage ({settings.distanceUnit})
                <input inputMode="numeric" value={String(w.tradeIn.mileage)} disabled={disabled} onChange={(ev) => set({ tradeIn: { ...w.tradeIn!, mileage: Number(ev.target.value.replace(/[,\s]/g, "")) || 0 } })} />
              </label>
              <MoneyInput label="Allowance (credited)" cents={w.tradeIn.allowanceCents} disabled={disabled} onChange={(c) => set({ tradeIn: { ...w.tradeIn!, allowanceCents: c } })} />
              <MoneyInput label="Loan payoff owed" cents={w.tradeIn.payoffCents} disabled={disabled} onChange={(c) => set({ tradeIn: { ...w.tradeIn!, payoffCents: c } })} />
              {seeCost ? (
                <MoneyInput label="Appraised value (ACV)" cents={w.tradeIn.acvCents} disabled={disabled} onChange={(c) => set({ tradeIn: { ...w.tradeIn!, acvCents: c } })} />
              ) : (
                <div className="small muted">Appraisal: {w.tradeIn.acvCents ? "done by a manager" : "a manager will appraise the car"}</div>
              )}
            </div>
          )}
        </section>

        <section className="card stack" aria-label="Payment">
          <h2>Payment</h2>
          <div className="form-grid three">
            <MoneyInput label="Deposit paid" cents={w.depositCents} onChange={(c) => set({ depositCents: c })} disabled={disabled} error={e("depositCents")} />
            <label className="check">
              <input type="checkbox" checked={!!w.finance} disabled={disabled} onChange={(ev) => set({ finance: ev.target.checked ? { lender: "", aprPercent: 6.9, termMonths: 60 } : null })} /> Financed
            </label>
          </div>
          {w.finance && (
            <div className="form-grid three">
              <label>
                Lender
                <input value={w.finance.lender} disabled={disabled} onChange={(ev) => set({ finance: { ...w.finance!, lender: ev.target.value } })} />
                {e("finance.lender") && <div className="field-error">{e("finance.lender")}</div>}
              </label>
              <label>
                APR %
                <input inputMode="decimal" value={String(w.finance.aprPercent)} disabled={disabled} onChange={(ev) => set({ finance: { ...w.finance!, aprPercent: Number(ev.target.value) || 0 } })} />
                {e("finance.aprPercent") && <div className="field-error">{e("finance.aprPercent")}</div>}
              </label>
              <label>
                Term
                <select value={w.finance.termMonths} disabled={disabled} onChange={(ev) => set({ finance: { ...w.finance!, termMonths: Number(ev.target.value) } })}>
                  {TERMS.map((m) => (
                    <option key={m} value={m}>
                      {m} months
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>
      </div>

      <aside className="card stack summary" aria-label="Deal summary">
        <h2>Summary{frozen ? " (as sold)" : ""}</h2>
        <dl className="totals">
          <dt>Price after discount</dt>
          <dd>{fmtMoney(t.netPriceCents)}</dd>
          {t.addOnsCents > 0 && (
            <>
              <dt>Add-ons</dt>
              <dd>{fmtMoney(t.addOnsCents)}</dd>
            </>
          )}
          <dt>Documentation fee</dt>
          <dd>{fmtMoney(w.docFeeCents)}</dd>
          <dt>Tax ({settings.taxPercent}%{settings.taxTradeInCredit && t.tradeAllowanceCents ? ", after trade-in credit" : ""})</dt>
          <dd>{fmtMoney(t.taxCents)}</dd>
          {t.tradeAllowanceCents > 0 && (
            <>
              <dt>Trade-in allowance</dt>
              <dd>−{fmtMoney(t.tradeAllowanceCents)}</dd>
            </>
          )}
          {t.tradePayoffCents > 0 && (
            <>
              <dt>Trade-in loan payoff</dt>
              <dd>{fmtMoney(t.tradePayoffCents)}</dd>
            </>
          )}
          <dt className="grand">Total</dt>
          <dd className="grand" data-testid="deal-total">
            {fmtMoney(t.totalCents)}
          </dd>
          <dt>Deposit</dt>
          <dd>−{fmtMoney(w.depositCents)}</dd>
          <dt>{w.finance ? "Amount financed" : "Balance due"}</dt>
          <dd>{fmtMoney(w.finance ? t.amountFinancedCents : t.balanceDueCents)}</dd>
        </dl>
        {w.finance && t.monthlyPaymentCents !== null && (
          <div className="stat">
            <span className="muted small">
              Monthly payment ({w.finance.termMonths} × at {w.finance.aprPercent}%)
            </span>
            <b data-testid="monthly">{fmtMoney(t.monthlyPaymentCents)}</b>
            <span className="muted small">{fmtMoney(t.totalOfPaymentsCents)} in total</span>
          </div>
        )}
        {seeCost && gross && (
          <div className={`gross ${gross.totalCents < settings.minGrossCents ? "gross-low" : ""}`} data-testid="gross">
            <div>
              Front gross <b>{fmtMoney(gross.frontCents)}</b>
            </div>
            <div>
              Back gross <b>{fmtMoney(gross.backCents)}</b>
            </div>
            <div>
              Total gross <b>{fmtMoney(gross.totalCents)}</b>
            </div>
            {gross.overAllowanceCents > 0 && <div className="small">Includes {fmtMoney(gross.overAllowanceCents)} of trade-in over-allowance</div>}
            {gross.totalCents < settings.minGrossCents && <div className="small">Below the {fmtMoney(settings.minGrossCents)} minimum: needs approval.</div>}
            {vehicleCostCents !== undefined && <div className="small muted">Vehicle cost {fmtMoney(vehicleCostCents)}</div>}
          </div>
        )}
        {!disabled && <p className="muted small">{fmtNum(settings.taxPercent)}% tax. Figures update as you type; save to keep them.</p>}
      </aside>
    </div>
  );
}

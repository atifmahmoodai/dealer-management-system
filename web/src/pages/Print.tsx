import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useLoadedMeta } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtDate, fmtMoney, fmtNum } from "../lib/format";
import type { Customer, Deal, ServiceOrder, Vehicle } from "../../../shared/types";

function usePrintWhenReady(ready: boolean) {
  useEffect(() => {
    if (ready && !navigator.webdriver) setTimeout(() => window.print(), 300);
  }, [ready]);
}

function Letterhead() {
  const meta = useLoadedMeta();
  const b = meta.branches[0];
  return (
    <header className="letterhead">
      <div>
        <h1>{meta.settings.companyName}</h1>
        {b && (
          <div className="small">
            {b.address} · {b.phone}
          </div>
        )}
      </div>
    </header>
  );
}

export function DealPrint() {
  const { id = "" } = useParams();
  const deal = useQuery({ queryKey: ["deal", id], queryFn: () => api<Deal>(`/deals/${id}`) });
  const cust = useQuery({ queryKey: ["customer", deal.data?.customerId], enabled: !!deal.data, queryFn: () => api<{ customer: Customer }>(`/customers/${deal.data!.customerId}`) });
  const veh = useQuery({ queryKey: ["vehicle", deal.data?.vehicleId], enabled: !!deal.data, queryFn: () => api<{ vehicle: Vehicle }>(`/vehicles/${deal.data!.vehicleId}`) });
  usePrintWhenReady(!!(deal.data && cust.data && veh.data));
  const meta = useLoadedMeta();
  if (deal.isError) return <div className="wrap notice">{errorText(deal.error)}</div>;
  if (!deal.data || !cust.data || !veh.data) return <div className="wrap muted">Loading…</div>;
  const d = deal.data;
  const c = cust.data.customer;
  const v = veh.data.vehicle;
  const w = d.worksheet;
  const t = d.totals;
  if (d.status !== "closed") return <div className="wrap notice">A bill of sale is available once the deal is closed.</div>;
  return (
    <div className="print-page">
      <Letterhead />
      <h2>Bill of sale {d.number}</h2>
      <p className="small">Date: {fmtDate(d.closedAt)}</p>
      <div className="print-cols">
        <section>
          <h3>Buyer</h3>
          <p>
            {c.name}
            <br />
            {c.address}
            <br />
            {c.phone} {c.email}
          </p>
        </section>
        <section>
          <h3>Vehicle</h3>
          <p>
            {v.year} {v.make} {v.model} {v.trim}
            <br />
            VIN {v.vin || "—"} · Stock {v.stockNo}
            <br />
            {fmtNum(v.mileage)} {meta.settings.distanceUnit} · {v.color} · {v.condition}
          </p>
        </section>
      </div>
      <table className="print-table">
        <tbody>
          <tr>
            <td>Vehicle price</td>
            <td className="r">{fmtMoney(w.salePriceCents)}</td>
          </tr>
          {w.discountCents > 0 && (
            <tr>
              <td>Discount</td>
              <td className="r">−{fmtMoney(w.discountCents)}</td>
            </tr>
          )}
          {w.addOns.map((a) => (
            <tr key={a.description}>
              <td>{a.description}</td>
              <td className="r">{fmtMoney(a.priceCents)}</td>
            </tr>
          ))}
          <tr>
            <td>Documentation fee</td>
            <td className="r">{fmtMoney(w.docFeeCents)}</td>
          </tr>
          <tr>
            <td>Sales tax</td>
            <td className="r">{fmtMoney(t.taxCents)}</td>
          </tr>
          {w.tradeIn && (
            <tr>
              <td>
                Trade-in allowance: {w.tradeIn.year} {w.tradeIn.make} {w.tradeIn.model} {w.tradeIn.vin && `(VIN ${w.tradeIn.vin})`}
              </td>
              <td className="r">−{fmtMoney(t.tradeAllowanceCents)}</td>
            </tr>
          )}
          {t.tradePayoffCents > 0 && (
            <tr>
              <td>Payoff of the loan on the trade-in</td>
              <td className="r">{fmtMoney(t.tradePayoffCents)}</td>
            </tr>
          )}
          <tr className="grand">
            <td>Total</td>
            <td className="r">{fmtMoney(t.totalCents)}</td>
          </tr>
          <tr>
            <td>Deposit paid</td>
            <td className="r">−{fmtMoney(w.depositCents)}</td>
          </tr>
          <tr className="grand">
            <td>{w.finance ? `Financed by ${w.finance.lender}` : "Balance due"}</td>
            <td className="r">{fmtMoney(t.balanceDueCents)}</td>
          </tr>
        </tbody>
      </table>
      {w.finance && t.monthlyPaymentCents !== null && (
        <p className="small">
          {w.finance.termMonths} monthly payments of {fmtMoney(t.monthlyPaymentCents)} at {w.finance.aprPercent}% APR (subject to the lender's contract).
        </p>
      )}
      <div className="signatures">
        <div>Buyer signature</div>
        <div>For {meta.settings.companyName}</div>
      </div>
    </div>
  );
}

export function ServicePrint() {
  const { id = "" } = useParams();
  const meta = useLoadedMeta();
  const q = useQuery({ queryKey: ["service-order", id], queryFn: () => api<ServiceOrder>(`/service/${id}`) });
  usePrintWhenReady(!!q.data);
  if (q.isError) return <div className="wrap notice">{errorText(q.error)}</div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const o = q.data;
  if (!o.invoiceNo) return <div className="wrap notice">An invoice is issued when a customer order is closed.</div>;
  return (
    <div className="print-page">
      <Letterhead />
      <h2>Invoice {o.invoiceNo}</h2>
      <p className="small">
        Date: {fmtDate(o.closedAt)} · Repair order {o.number}
      </p>
      <p>
        <strong>{o.customerName}</strong>
        <br />
        {o.vehicleDesc} {o.plate && `· ${o.plate}`} {o.mileage !== null && `· ${fmtNum(o.mileage)} ${meta.settings.distanceUnit}`}
      </p>
      <p className="small">Work requested: {o.complaint}</p>
      <table className="print-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="r">Qty / hours</th>
            <th className="r">Price</th>
            <th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.kind === "labour" ? "Labour: " : ""}
                {l.description}
              </td>
              <td className="r">{l.quantity}</td>
              <td className="r">{fmtMoney(l.unitCents)}</td>
              <td className="r">{fmtMoney(Math.round(l.quantity * l.unitCents))}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>Subtotal</td>
            <td className="r">{fmtMoney(o.subtotalCents)}</td>
          </tr>
          <tr>
            <td colSpan={3}>Tax</td>
            <td className="r">{fmtMoney(o.taxCents)}</td>
          </tr>
          <tr className="grand">
            <td colSpan={3}>Total</td>
            <td className="r">{fmtMoney(o.totalCents)}</td>
          </tr>
        </tbody>
      </table>
      <p className="small">Technician: {o.technician || "—"}. Thank you for your business.</p>
    </div>
  );
}

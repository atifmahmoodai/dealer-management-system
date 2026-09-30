import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorText } from "../api/client";
import { Modal, NewCustomerForm } from "../components/ui";
import { fmtDate } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";
import type { Customer } from "../../../shared/types";

type Row = Customer & { purchases: number; openLeads: number };

export function Customers() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [adding, setAdding] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ["customers", dq],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<{ items: Row[]; hasMore: boolean }>(`/customers?${new URLSearchParams({ q: dq, page: String(pageParam) })}`),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Customers</h1>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + New customer
        </button>
      </div>
      <input type="search" placeholder="Search by name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      {list.isError && <div className="notice">{errorText(list.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th className="r">Cars bought</th>
              <th className="r">Open leads</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="clickable" tabIndex={0} onClick={() => nav(`/customers/${c.id}`)} onKeyDown={(e) => e.key === "Enter" && nav(`/customers/${c.id}`)}>
                <td>
                  <Link to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>
                    {c.name}
                  </Link>
                </td>
                <td>{c.phone}</td>
                <td>{c.email}</td>
                <td className="r">{c.purchases || ""}</td>
                <td className="r">{c.openLeads || ""}</td>
                <td>{fmtDate(c.createdAt)}</td>
              </tr>
            ))}
            {!list.isPending && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted center">
                  No customers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.hasNextPage && (
        <div>
          <button className="btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Show more
          </button>
        </div>
      )}
      {adding && (
        <Modal title="New customer" onClose={() => setAdding(false)}>
          <NewCustomerForm initialName={q} onCancel={() => setAdding(false)} onCreated={(c) => nav(`/customers/${c.id}`)} />
        </Modal>
      )}
    </div>
  );
}

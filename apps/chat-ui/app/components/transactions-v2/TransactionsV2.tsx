import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  CaretDown,
  CaretUp,
  MagnifyingGlass,
  X,
} from 'phosphor-react';
import { toast } from 'sonner';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import {
  SEED_TXNS,
  TYPE_LABEL,
  filingOf,
  signed,
  sum,
  type Direction,
  type Filing,
  type Source,
  type Txn,
  type TxnType,
} from './data';
import { FILING_LABEL, FILING_TONE, TransactionDrawerV2 } from './TransactionDrawerV2';
import { Eyebrow, Segmented, StatusChipRaw, gbp, int, pct } from '../dashboard-v2/ui-shared';

const PAGE_SIZE = 25;

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayLabel = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};
const money = (n: number, c = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: c }).format(n);

interface Filters {
  search: string;
  direction: 'all' | Direction;
  filing: 'all' | Filing;
  source: '' | Source;
  type: '' | TxnType;
  from: string;
  to: string;
}
const EMPTY: Filters = {
  search: '',
  direction: 'all',
  filing: 'all',
  source: '',
  type: '',
  from: '',
  to: '',
};

export function TransactionsV2() {
  const [txns, setTxns] = useState<Txn[]>(SEED_TXNS);
  const [f, setF] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [pickerHost, setPickerHost] = useState<HTMLElement | null>(null);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('transactionId');

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setF(cur => ({ ...cur, [k]: v }));
    setPage(1);
  };

  const filtered = useMemo(() => {
    const q = f.search.trim().toLowerCase();
    return txns.filter(t => {
      if (f.direction !== 'all' && t.direction !== f.direction) return false;
      if (f.filing !== 'all' && filingOf(t) !== f.filing) return false;
      if (f.source && t.source !== f.source) return false;
      if (f.type && t.type !== f.type) return false;
      const day = dayKey(t.occurredAt);
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
      if (q && !`${t.counterparty} ${t.description} ${t.reference}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [txns, f]);

  // Excluded rows (internal transfers) move no real money, so they stay out of the totals.
  const counted = filtered.filter(t => !t.excludedReason);
  const moneyIn = sum(counted.filter(t => t.direction === 'in').map(t => t.baseAmount));
  const moneyOut = sum(counted.filter(t => t.direction === 'out').map(t => t.baseAmount));
  const pending = filtered.filter(t => filingOf(t) === 'pending').length;
  const journalled = filtered.filter(t => filingOf(t) === 'journalled').length;
  const excluded = filtered.length - counted.length;

  const eligible = txns.filter(t => !t.excludedReason);
  const overallFiled = eligible.length
    ? (eligible.filter(t => filingOf(t) === 'journalled').length / eligible.length) * 100
    : 100;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const groups = useMemo(() => {
    const map = new Map<string, Txn[]>();
    for (const t of pageRows) {
      const k = dayKey(t.occurredAt);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()];
  }, [pageRows]);

  const activeCount = [
    f.search,
    f.direction !== 'all',
    f.filing !== 'all',
    f.source,
    f.type,
    f.from || f.to,
  ].filter(Boolean).length;
  const rangeLabel = f.from || f.to ? 'in range' : 'all time';

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('transactionId', id);
    else next.delete('transactionId');
    setParams(next, { replace: true });
  };
  const selected = txns.find(t => t.id === selectedId) ?? null;

  return (
    <>
      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 64, paddingBottom: 48 }}>
        <Eyebrow>Transactions · Revolut and PayPal</Eyebrow>
        <h1 className="cv2-h1" style={{ marginTop: 20, maxWidth: 860 }}>
          Every pound in and out, <em>and where it was filed.</em>
        </h1>
        <p className="cv2-lead" style={{ marginTop: 24 }}>
          {int(txns.length)} movements, {pct(overallFiled, 0)} filed to the ledger. Search, inspect
          and correct any of them.
        </p>
        <div style={{ marginTop: 32 }}>
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary"
            onClick={() => toast.success('Transactions refreshed')}
          >
            <ArrowClockwise size={16} weight="light" /> Refresh
          </button>
        </div>
      </header>

      <section className="cv2-wrap cv2-rise" style={{ animationDelay: '60ms' }}>
        <div className="cv2-stats">
          <div className="cv2-stat">
            <Eyebrow>Money in</Eyebrow>
            <div className="cv2-stat-value cv2-in">{gbp(moneyIn)}</div>
            <div className="cv2-stat-label">
              {int(counted.filter(t => t.direction === 'in').length)} inbound
            </div>
            <div className="cv2-stat-cap">Excludes internal transfers</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Money out</Eyebrow>
            <div className="cv2-stat-value">{gbp(moneyOut)}</div>
            <div className="cv2-stat-label">
              {int(counted.filter(t => t.direction === 'out').length)} outbound
            </div>
            <div className="cv2-stat-cap">Refunds and fees included</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Net movement</Eyebrow>
            <div className={`cv2-stat-value ${moneyIn - moneyOut < 0 ? 'cv2-neg' : ''}`}>
              {moneyIn - moneyOut < 0 ? '−' : ''}
              {gbp(Math.abs(moneyIn - moneyOut))}
            </div>
            <div className="cv2-stat-label">In less out</div>
            <div className="cv2-stat-cap">
              For {rangeLabel}
              {activeCount > 1 || (activeCount === 1 && !(f.from || f.to))
                ? ', current filters'
                : ''}
            </div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Needs filing</Eyebrow>
            <div className="cv2-stat-value">{pending}</div>
            <div className="cv2-stat-label">Pending a journal</div>
            <div className="cv2-stat-cap">
              {journalled} journalled · {excluded} excluded
            </div>
          </div>
        </div>
      </section>

      {/* Filters */}
      <section className="cv2-wrap" style={{ marginTop: 72 }}>
        <div className="cv2-between" style={{ flexWrap: 'wrap', marginBottom: 16, gap: 12 }}>
          <div className="cv2-search" style={{ maxWidth: 380 }}>
            <MagnifyingGlass size={16} weight="light" />
            <input
              className="cv2-input"
              value={f.search}
              onChange={e => set('search', e.target.value)}
              placeholder="Search counterparty, description or reference"
              aria-label="Search transactions"
            />
          </div>
          <div className="cv2-flex" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div ref={setPickerHost} className="cv2-picker">
              <DateRangePicker
                from={f.from}
                to={f.to}
                onApply={(from, to) => {
                  setF(c => ({ ...c, from, to }));
                  setPage(1);
                }}
                className="cv2-picker-trigger"
                portalContainer={pickerHost}
              />
            </div>
          </div>
        </div>

        <div className="cv2-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="cv2-flex" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Segmented<'all' | Direction>
              label="Direction"
              value={f.direction}
              onChange={v => set('direction', v)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'in', label: 'In' },
                { value: 'out', label: 'Out' },
              ]}
            />
            <Segmented<'all' | Filing>
              label="Filing status"
              value={f.filing}
              onChange={v => set('filing', v)}
              options={[
                { value: 'all', label: 'Any status' },
                { value: 'pending', label: 'Pending' },
                { value: 'journalled', label: 'Journalled' },
                { value: 'excluded', label: 'Excluded' },
              ]}
            />
          </div>
          <div className="cv2-flex" style={{ gap: 16 }}>
            <button
              type="button"
              className="cv2-link cv2-2"
              onClick={() => setMore(v => !v)}
              aria-expanded={more}
            >
              More filters{' '}
              {more ? <CaretUp size={12} weight="light" /> : <CaretDown size={12} weight="light" />}
            </button>
            {activeCount > 0 && (
              <button
                type="button"
                className="cv2-link cv2-link-accent"
                onClick={() => {
                  setF(EMPTY);
                  setPage(1);
                }}
              >
                <X size={12} /> Clear {activeCount}
              </button>
            )}
          </div>
        </div>

        {more && (
          <div className="cv2-flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            <select
              className="cv2-select"
              style={{ width: 180, borderRadius: 9999 }}
              value={f.source}
              onChange={e => set('source', e.target.value as Filters['source'])}
              aria-label="Source"
            >
              <option value="">All sources</option>
              <option value="revolut">Revolut</option>
              <option value="paypal">PayPal</option>
            </select>
            <select
              className="cv2-select"
              style={{ width: 200, borderRadius: 9999 }}
              value={f.type}
              onChange={e => set('type', e.target.value as Filters['type'])}
              aria-label="Type"
            >
              <option value="">All types</option>
              {(Object.keys(TYPE_LABEL) as TxnType[]).map(k => (
                <option key={k} value={k}>
                  {TYPE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* List */}
      <section className="cv2-wrap" style={{ marginTop: 28, paddingBottom: 112 }}>
        <div className="cv2-card" style={{ overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '72px 24px', textAlign: 'center' }}>
              <h3 className="cv2-h3" style={{ fontSize: 24 }}>
                No transactions found.
              </h3>
              <p className="cv2-2" style={{ margin: '8px 0 16px' }}>
                Nothing matches these filters.
              </p>
              <button
                type="button"
                className="cv2-btn cv2-btn-secondary cv2-btn-sm"
                onClick={() => {
                  setF(EMPTY);
                  setPage(1);
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            groups.map(([key, rows]) => {
              const net = sum(rows.filter(t => !t.excludedReason).map(signed));
              return (
                <div key={key}>
                  <div className="cv2-day">
                    <span className="cv2-eyebrow">{dayLabel(key)}</span>
                    <span
                      className={`cv2-mono cv2-num ${net > 0 ? 'cv2-in' : 'cv2-2'}`}
                      style={{ fontSize: 13 }}
                    >
                      {net > 0 ? '+' : net < 0 ? '−' : ''}
                      {money(Math.abs(net))}
                    </span>
                  </div>
                  {rows.map(t => {
                    const fl = filingOf(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className="cv2-txn"
                        data-excluded={fl === 'excluded'}
                        onClick={() => open(t.id)}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div className="cv2-txn-title">{t.counterparty}</div>
                          <div className="cv2-muted cv2-txn-title" style={{ fontSize: 13 }}>
                            {t.description}
                          </div>
                        </div>
                        <div
                          className="cv2-txn-type cv2-mono cv2-muted"
                          style={{ fontSize: 12, letterSpacing: '0.04em' }}
                        >
                          {TYPE_LABEL[t.type].toUpperCase()}
                          <br />
                          {t.source === 'revolut' ? 'REVOLUT' : 'PAYPAL'}
                        </div>
                        <div className="cv2-txn-filing">
                          <StatusChipRaw tone={FILING_TONE[fl]}>{FILING_LABEL[fl]}</StatusChipRaw>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div
                            className={`cv2-num ${t.direction === 'in' ? 'cv2-in' : ''}`}
                            style={{ fontWeight: 500 }}
                          >
                            {t.direction === 'in' ? '+' : '−'}
                            {money(t.baseAmount)}
                          </div>
                          {t.currency !== 'GBP' && (
                            <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                              {money(t.amount, t.currency)}
                            </div>
                          )}
                        </div>
                        <ArrowRight className="cv2-txn-caret" size={14} weight="light" />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {totalPages > 1 && (
          <div className="cv2-between" style={{ marginTop: 20, flexWrap: 'wrap' }}>
            <span className="cv2-mono cv2-muted" style={{ fontSize: 12, letterSpacing: '0.04em' }}>
              {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} OF{' '}
              {int(filtered.length)}
            </span>
            <div className="cv2-flex" style={{ gap: 12 }}>
              <button
                type="button"
                className="cv2-btn cv2-btn-secondary cv2-btn-sm"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                <ArrowLeft size={14} weight="light" /> Prev
              </button>
              <span className="cv2-mono cv2-2" style={{ fontSize: 13 }}>
                {safePage} / {totalPages}
              </span>
              <button
                type="button"
                className="cv2-btn cv2-btn-secondary cv2-btn-sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
              >
                Next <ArrowRight size={14} weight="light" />
              </button>
            </div>
          </div>
        )}
      </section>

      {selected && (
        <TransactionDrawerV2
          txn={selected}
          onClose={() => open(null)}
          onUpdate={(next, message, info) => {
            setTxns(cur => cur.map(t => (t.id === next.id ? next : t)));
            toast.success(message);
            if (info) toast.info(info);
          }}
        />
      )}
    </>
  );
}

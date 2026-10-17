import React from 'react';
import { CaretRight } from 'phosphor-react';
import { entriesFor, type Account } from './data';
import { Drawer, Eyebrow, fmtDate, gbp } from '../collections-v2/ui';

/** Accounting style: deductions and negatives in brackets. */
export const acct = (n: number) => (n < 0 ? `(${gbp(-n)})` : gbp(n));

export type Row =
  | { kind: 'section'; label: string }
  | {
      kind: 'line' | 'total' | 'grand';
      label: string;
      amount: number;
      /** Show as a deduction: (£1,200). */
      deduct?: boolean;
      indent?: boolean;
      onClick?: () => void;
    };

export function Statement({ rows, valueLabel = 'Balance' }: { rows: Row[]; valueLabel?: string }) {
  return (
    <table className="cv2-stmt">
      <caption style={{ display: 'none' }}>{valueLabel}</caption>
      <tbody>
        {rows.map((r, i) => {
          if (r.kind === 'section') {
            return (
              <tr key={i} className="section">
                <td colSpan={2}>{r.label}</td>
              </tr>
            );
          }
          const shown = r.deduct ? -Math.abs(r.amount) : r.amount;
          return (
            <tr
              key={i}
              className={`${r.kind} ${r.indent ? 'indent' : ''} ${r.deduct ? 'deduct' : ''}`}
            >
              <td>
                {r.onClick ? (
                  <button
                    type="button"
                    className="cv2-stmt-btn"
                    onClick={r.onClick}
                    aria-label={`View ${r.label} entries`}
                  >
                    {r.label}
                    <CaretRight size={12} weight="light" />
                  </button>
                ) : (
                  r.label
                )}
              </td>
              <td>{acct(shown)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Journal entries behind one account balance. */
export function AccountDrawer({
  account,
  endLabel,
  onClose,
}: {
  account: Account;
  endLabel: string;
  onClose: () => void;
}) {
  const entries = entriesFor(account, endLabel);
  return (
    <Drawer
      eyebrow={`Account ${account.code}`}
      title={account.name}
      onClose={onClose}
      footer={
        <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div>
        <Eyebrow>Balance</Eyebrow>
        <div className="cv2-serif-num" style={{ fontSize: 44, lineHeight: 1.05, marginTop: 6 }}>
          {acct(account.balance)}
        </div>
        <div className="cv2-muted" style={{ fontSize: 13, marginTop: 4 }}>
          {entries.length} posted journals
        </div>
      </div>
      <hr className="cv2-rule" />
      <div>
        {entries.map(e => (
          <div
            key={e.id}
            className="cv2-between"
            style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}
          >
            <div>
              <div>{e.source}</div>
              <div className="cv2-mono cv2-muted" style={{ fontSize: 12, marginTop: 2 }}>
                {fmtDate(e.date, true).toUpperCase()} · {e.reference}
              </div>
            </div>
            <div className="cv2-num">{acct(e.amount)}</div>
          </div>
        ))}
      </div>
      <p className="cv2-muted" style={{ fontSize: 13, margin: 0 }}>
        Sample rows for the preview. The live page loads the real journal lines for this account.
      </p>
    </Drawer>
  );
}

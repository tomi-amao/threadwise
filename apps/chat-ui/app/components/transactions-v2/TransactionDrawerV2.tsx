import React, { useState } from 'react';
import { CaretDown, CaretUp } from 'phosphor-react';
import {
  ACCOUNTS,
  TYPE_LABEL,
  accountName,
  filingOf,
  journalFor,
  sum,
  type Filing,
  type Txn,
} from './data';
import { Drawer, Eyebrow, Field, StatusChipRaw, gbp } from '../dashboard-v2/ui-shared';

const FILING_TONE: Record<Filing, string> = {
  journalled: 'completed',
  pending: 'active',
  excluded: 'draft',
};
const FILING_LABEL: Record<Filing, string> = {
  journalled: 'Journalled',
  pending: 'Pending',
  excluded: 'Excluded',
};
export { FILING_TONE, FILING_LABEL };

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function EditForm({
  txn,
  onSave,
}: {
  txn: Txn;
  onSave: (next: Txn, message: string, info?: string) => void;
}) {
  const [description, setDescription] = useState(txn.description);
  const [counterparty, setCounterparty] = useState(txn.counterparty);
  const [accountCode, setAccountCode] = useState(txn.accountCode);
  const [excluded, setExcluded] = useState(!!txn.excludedReason);
  const [reason, setReason] = useState(txn.excludedReason ?? '');

  const save = () => {
    const wasJournalled = !!txn.journalisedAt;
    const accountChanged = accountCode !== txn.accountCode;
    const next: Txn = {
      ...txn,
      description,
      counterparty,
      accountCode,
      excludedReason: excluded ? reason || 'Manually excluded' : null,
    };
    let message = 'Transaction updated.';
    let info: string | undefined;

    if (excluded) {
      next.journalisedAt = null;
      if (wasJournalled) message = 'Transaction updated — journal reversed.';
    } else if (txn.excludedReason) {
      next.journalisedAt = null;
      info = 'Transaction un-excluded. You can now post a new journal for it.';
    } else if (wasJournalled && accountChanged) {
      next.journalisedAt = new Date().toISOString();
      message = 'Transaction updated — journal reversed and recreated.';
    }
    onSave(next, message, info);
  };

  return (
    <div style={{ display: 'grid', gap: 16, paddingTop: 16 }}>
      {txn.journalisedAt && (
        <div className="cv2-note">
          <b>!</b>
          <span>
            This transaction has a posted journal. Changing the account reverses it and creates a
            corrected entry.
          </span>
        </div>
      )}
      <Field label="Description">
        <input
          className="cv2-input"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Counterparty">
        <input
          className="cv2-input"
          value={counterparty}
          onChange={e => setCounterparty(e.target.value)}
        />
      </Field>
      <Field label="Ledger account">
        <select
          className="cv2-select"
          value={accountCode}
          onChange={e => setAccountCode(e.target.value)}
        >
          {ACCOUNTS.map(a => (
            <option key={a.code} value={a.code}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </Field>
      <label className="cv2-flex" style={{ gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={excluded}
          onChange={e => setExcluded(e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
        />
        <span>Exclude from the ledger</span>
      </label>
      {excluded && (
        <input
          className="cv2-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason, e.g. Internal transfer"
          aria-label="Exclusion reason"
        />
      )}
      <div>
        <button type="button" className="cv2-btn cv2-btn-primary" onClick={save}>
          Save changes
        </button>
      </div>
    </div>
  );
}

export function TransactionDrawerV2({
  txn,
  onClose,
  onUpdate,
}: {
  txn: Txn;
  onClose: () => void;
  onUpdate: (next: Txn, message: string, info?: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const filing = filingOf(txn);
  const lines = journalFor(txn);
  const foreign = txn.currency !== 'GBP';
  const fmt = (n: number, c = 'GBP') =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: c }).format(n);

  return (
    <Drawer
      eyebrow={`${TYPE_LABEL[txn.type]} · ${txn.source}`}
      title={txn.counterparty || 'No counterparty'}
      onClose={onClose}
      footer={
        <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div>
        <div
          className={`cv2-serif-num ${txn.direction === 'in' ? 'cv2-in' : ''}`}
          style={{ fontSize: 52, lineHeight: 1.05 }}
        >
          {txn.direction === 'in' ? '+' : '−'}
          {fmt(txn.baseAmount)}
        </div>
        {foreign && (
          <div className="cv2-mono cv2-muted" style={{ fontSize: 12, marginTop: 6 }}>
            {fmt(txn.amount, txn.currency)} AT {txn.fxRate}
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <StatusChipRaw tone={FILING_TONE[filing]}>{FILING_LABEL[filing]}</StatusChipRaw>
        </div>
      </div>

      <dl className="cv2-dl">
        <div>
          <dt>Date</dt>
          <dd>{longDate(txn.occurredAt)}</dd>
        </div>
        <div>
          <dt>Description</dt>
          <dd>{txn.description || '—'}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd className="cv2-mono" style={{ fontSize: 13 }}>
            {txn.reference}
          </dd>
        </div>
        {filing === 'journalled' && (
          <div>
            <dt>Account</dt>
            <dd>
              {txn.accountCode} · {accountName(txn.accountCode)}
            </dd>
          </div>
        )}
        {txn.excludedReason && (
          <div>
            <dt>Excluded because</dt>
            <dd>{txn.excludedReason}</dd>
          </div>
        )}
      </dl>

      <hr className="cv2-rule" />

      <div>
        <Eyebrow>Journal</Eyebrow>
        {lines ? (
          <>
            <table className="cv2-ledger" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Debit</th>
                  <th>Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.account}>
                    <td>{l.account}</td>
                    <td>{l.debit ? gbp(l.debit, 2) : '—'}</td>
                    <td>{l.credit ? gbp(l.credit, 2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Balanced</td>
                  <td>{gbp(sum(lines.map(l => l.debit)), 2)}</td>
                  <td>{gbp(sum(lines.map(l => l.credit)), 2)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="cv2-muted" style={{ fontSize: 13, marginTop: 8 }}>
              Posted{' '}
              {new Date(txn.journalisedAt!).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </div>
          </>
        ) : (
          <div style={{ marginTop: 10 }}>
            <p className="cv2-2" style={{ margin: '0 0 12px' }}>
              {filing === 'excluded'
                ? 'Excluded transactions never reach the ledger.'
                : 'No journal entry exists for this transaction yet.'}
            </p>
            {filing === 'pending' && (
              <button
                type="button"
                className="cv2-btn cv2-btn-secondary cv2-btn-sm"
                onClick={() =>
                  onUpdate({ ...txn, journalisedAt: new Date().toISOString() }, 'Journal posted.')
                }
              >
                Post journal to {txn.accountCode}
              </button>
            )}
          </div>
        )}
      </div>

      <hr className="cv2-rule" />

      <div>
        <button
          type="button"
          className="cv2-between"
          style={{ width: '100%', background: 'none', border: 0, padding: 0 }}
          onClick={() => setEditOpen(v => !v)}
          aria-expanded={editOpen}
        >
          <Eyebrow>Edit transaction</Eyebrow>
          {editOpen ? <CaretUp size={14} weight="light" /> : <CaretDown size={14} weight="light" />}
        </button>
        {editOpen && (
          <EditForm
            key={txn.id + (txn.journalisedAt ?? '') + txn.accountCode}
            txn={txn}
            onSave={onUpdate}
          />
        )}
      </div>
    </Drawer>
  );
}

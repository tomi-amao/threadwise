/**
 * Small shared bits for the v2 pages. Re-exports the primitives from the
 * collections-v2 folder (where they were first built) and adds a free-form chip.
 */
import React from 'react';

export {
  Eyebrow,
  Segmented,
  RAMP,
  Meter,
  Drawer,
  Field,
  fmtDate,
  gbp,
  int,
  pct,
} from '../collections-v2/ui';

/** Same chip look as StatusChip, but takes any tone so it isn't tied to collection statuses. */
export function StatusChipRaw({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`cv2-chip cv2-chip-${tone}`}>{children}</span>;
}

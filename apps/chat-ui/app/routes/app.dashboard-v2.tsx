/**
 * Dashboard v2 — design-language preview.
 *
 * Frontend-only redesign of /dashboard following docs/design-language.md.
 * No loader: it runs on local mock data, so the original /dashboard page, its
 * onboarding flow and its backend wiring stay untouched.
 */

import React from 'react';
import type { LinksFunction, MetaFunction } from 'react-router';
import { DashboardV2 } from '~/components/dashboard-v2/DashboardV2';
import { ThemeToggle, useCv2Theme } from '~/components/collections-v2/theme';
import '~/components/collections-v2/collections-v2.css';
import '~/components/reports-v2/reports-v2.css';

export const meta: MetaFunction = () => [
  { title: 'Dashboard (new design) - ThreadWise' },
  { name: 'description', content: 'Design-language preview of the Dashboard' },
];

export const links: LinksFunction = () => [
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400&display=swap',
  },
];

export default function DashboardV2Page() {
  const [dark, setDark] = useCv2Theme();

  return (
    <div className="cv2" data-theme={dark ? 'dark' : 'light'}>
      <div className="cv2-glow" aria-hidden />
      <div className="cv2-wrap" style={{ paddingTop: 20 }}>
        <div className="cv2-between">
          <span className="cv2-chip cv2-chip-active cv2-chip-plain">
            Preview · new design · mock data
          </span>
          <ThemeToggle dark={dark} onChange={setDark} />
        </div>
      </div>
      <DashboardV2 />
    </div>
  );
}

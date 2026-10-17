/**
 * Collections v2 — design-language preview.
 *
 * Frontend-only redesign of /collections following docs/design-language.md.
 * No loader/action: it runs on local mock data (edits reset on reload), so the
 * original /collections page and its backend wiring stay untouched.
 */

import React, { useEffect, useState } from 'react';
import type { LinksFunction, MetaFunction } from 'react-router';
import { useSearchParams } from 'react-router';
import { Moon, Sun } from 'phosphor-react';
import { toast } from 'sonner';
import { CollectionDetail, type TabId } from '~/components/collections-v2/CollectionDetail';
import { CollectionsIndex } from '~/components/collections-v2/CollectionsIndex';
import { CreateCollectionDrawer } from '~/components/collections-v2/drawers';
import { SEED, type Collection } from '~/components/collections-v2/data';
import '~/components/collections-v2/collections-v2.css';

export const meta: MetaFunction = () => [
  { title: 'Collections (new design) - ThreadWise' },
  { name: 'description', content: 'Design-language preview of the Collections page' },
];

export const links: LinksFunction = () => [
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400&display=swap',
  },
];

const TABS: TabId[] = ['overview', 'plan', 'products', 'costs'];

export default function CollectionsV2() {
  const [collections, setCollections] = useState<Collection[]>(SEED);
  const [dark, setDark] = useState(false);
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();

  const selectedId = params.get('c');
  const rawTab = params.get('tab') as TabId | null;
  const tab: TabId = rawTab && TABS.includes(rawTab) ? rawTab : 'overview';
  const selected = collections.find(c => c.id === selectedId) ?? null;

  // Restore the saved theme after hydration (SSR always renders light).
  useEffect(() => {
    try {
      if (localStorage.getItem('cv2-theme') === 'dark') setDark(true);
    } catch {
      /* storage unavailable — stay on light */
    }
  }, []);

  const setTheme = (next: boolean) => {
    setDark(next);
    try {
      localStorage.setItem('cv2-theme', next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  };

  const open = (id: string, nextTab: TabId = 'overview') => {
    setParams({ c: id, tab: nextTab });
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="cv2" data-theme={dark ? 'dark' : 'light'} data-palette="white">
      <div className="cv2-glow" aria-hidden />

      <div className="cv2-wrap" style={{ paddingTop: 20 }}>
        <div className="cv2-between">
          <span className="cv2-chip cv2-chip-active cv2-chip-plain">
            Preview · new design · mock data
          </span>
          <div className="cv2-seg" role="group" aria-label="Theme">
            <button type="button" aria-pressed={!dark} onClick={() => setTheme(false)}>
              <Sun size={14} weight="light" style={{ marginRight: 6, verticalAlign: '-2px' }} />
              Light
            </button>
            <button type="button" aria-pressed={dark} onClick={() => setTheme(true)}>
              <Moon size={14} weight="light" style={{ marginRight: 6, verticalAlign: '-2px' }} />
              Dark
            </button>
          </div>
        </div>
      </div>

      {selected ? (
        <CollectionDetail
          collection={selected}
          tab={tab}
          onTab={t => setParams({ c: selected.id, tab: t }, { replace: true })}
          onBack={() => setParams({})}
          onUpdate={fn => setCollections(cs => cs.map(c => (c.id === selected.id ? fn(c) : c)))}
        />
      ) : (
        <CollectionsIndex
          collections={collections}
          onOpen={id => open(id)}
          onCreate={() => setCreating(true)}
        />
      )}

      {creating && (
        <CreateCollectionDrawer
          onClose={() => setCreating(false)}
          onCreate={c => {
            setCollections(cs => [c, ...cs]);
            setCreating(false);
            toast.success(`${c.name} created`);
            open(c.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * CollectionPage: one collection. Overview (how it is doing), Plan (the forecast), Products and
 * Costs. The header carries what is true of the whole collection and one amber action that
 * always matches the tab. Tab and any open drawer live in the URL.
 */

import { ArrowLeft, DownloadSimple, PencilSimple, Plus } from 'phosphor-react';
import { Link } from 'react-router';
import { Button, buttonVariants } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { CompactHeader } from '~/components/ui/page-header';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { CollectionDetail } from '~/lib/api/collections.server';
import { useUrlParams } from '~/lib/use-url-params';
import { CollectionDrawer } from './CollectionDrawer';
import { AddCostDrawer, CostsTab, EditCostDrawer } from './CostsTab';
import { OverviewTab } from './OverviewTab';
import { LineDrawer, PlanCostDrawer, TermsDrawer } from './PlanDrawers';
import { PlanTab } from './PlanTab';
import { AddProductsDrawer, EditProductDrawer, ProductsTab } from './ProductsTab';
import { STATUS, isTab, shortDate, type TabId } from './model';

export function CollectionPage({ detail }: { detail: CollectionDetail }) {
  const [sp, apply] = useUrlParams();
  const { collection, plan } = detail;

  const rawTab = sp.get('tab');
  const tab: TabId = isTab(rawTab) ? rawTab : 'overview';
  const drawer = sp.get('drawer');
  const item = sp.get('item');

  const set = (patch: Record<string, string | null>) =>
    apply(p => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      return p;
    });
  const close = () => set({ drawer: null, item: null });
  const openDrawer = (name: string, id: string | null = null) => set({ drawer: name, item: id });

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'plan' as const, label: 'Plan' },
    { id: 'products' as const, label: 'Products', count: detail.memberships.length },
    { id: 'costs' as const, label: 'Costs', count: detail.costs.length },
  ];

  // One amber action per view, and it always matches what the tab is for.
  const primary =
    tab === 'products'
      ? { label: 'Add products', run: () => openDrawer('product') }
      : tab === 'plan'
        ? plan
          ? { label: 'Add line', run: () => openDrawer('line') }
          : null
        : tab === 'costs'
          ? { label: 'Add cost', run: () => openDrawer('cost') }
          : null;

  const takenProducts = new Set(
    detail.memberships.map(m => m.productId).filter((id): id is string => !!id)
  );
  const membership = detail.memberships.find(m => m.id === item) ?? null;
  const cost = detail.costs.find(c => c.id === item) ?? null;
  const line = plan?.lines.find(l => l.id === item) ?? null;
  const planCost = plan?.costs.find(c => c.id === item) ?? null;

  const facts = [
    collection.launchDate ? `Launches ${shortDate(collection.launchDate)}` : 'No launch date set',
    `${detail.memberships.length} ${detail.memberships.length === 1 ? 'product' : 'products'}`,
    detail.sales.orders ? `${detail.sales.orders} orders` : 'no orders yet',
  ].join(' · ');

  return (
    <div className="pb-10">
      <div className="px-4 pt-6 sm:px-6 lg:px-8">
        <Link
          to="/collections"
          className="inline-flex items-center gap-2 rounded-sm text-[15px] text-text-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft size={16} weight="light" aria-hidden /> All collections
        </Link>
      </div>

      <CompactHeader
        className="px-4 pt-4 sm:px-6 lg:px-8"
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <Chip tone={STATUS[collection.status].tone} dot>
              {STATUS[collection.status].label}
            </Chip>
            <span>
              {collection.type || 'Collection'}
              {collection.externalRef ? ` · ${collection.externalRef}` : ''}
            </span>
          </span>
        }
        title={collection.name}
        description={facts}
        actions={
          <>
            <Button variant="outline" onClick={() => openDrawer('edit')}>
              <PencilSimple size={16} weight="light" aria-hidden /> Edit
            </Button>
            {plan && (
              <a
                href={`/api/collections/plan-pack?collection=${collection.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'outline' })}
              >
                <DownloadSimple size={16} weight="light" aria-hidden /> Export pack
              </a>
            )}
            {primary && (
              <Button onClick={primary.run}>
                <Plus size={16} weight="bold" aria-hidden /> {primary.label}
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <Tabs
          tabs={tabs.map(t => ({ id: t.id, label: t.label, count: t.count }))}
          value={tab}
          onChange={id => set({ tab: id === 'overview' ? null : id, drawer: null, item: null })}
        />

        <div role="tabpanel" aria-labelledby={tabId(tab)}>
          {tab === 'overview' && <OverviewTab detail={detail} />}
          {tab === 'plan' && (
            <PlanTab
              detail={detail}
              onTerms={() => openDrawer('terms')}
              onLine={id => openDrawer('line', id)}
              onCost={id => openDrawer('plancost', id)}
            />
          )}
          {tab === 'products' && (
            <ProductsTab
              memberships={detail.memberships}
              onAdd={() => openDrawer('product')}
              onEdit={id => openDrawer('editproduct', id)}
            />
          )}
          {tab === 'costs' && (
            <CostsTab
              costs={detail.costs}
              onAdd={() => openDrawer('cost')}
              onEdit={id => openDrawer('editcost', id)}
            />
          )}
        </div>
      </div>

      <CollectionDrawer collection={collection} open={drawer === 'edit'} onClose={close} />
      <AddProductsDrawer
        options={detail.productOptions}
        taken={takenProducts}
        open={drawer === 'product'}
        onClose={close}
      />
      <EditProductDrawer membership={membership} open={drawer === 'editproduct'} onClose={close} />
      <AddCostDrawer collectionId={collection.id} open={drawer === 'cost'} onClose={close} />
      <EditCostDrawer cost={cost} open={drawer === 'editcost'} onClose={close} />
      {plan && (
        <>
          <TermsDrawer plan={plan.plan} open={drawer === 'terms'} onClose={close} />
          <LineDrawer
            line={line}
            planCurrency={plan.plan.currency}
            products={detail.productOptions}
            open={drawer === 'line'}
            onClose={close}
          />
          <PlanCostDrawer
            cost={planCost}
            currency={plan.plan.currency}
            open={drawer === 'plancost'}
            onClose={close}
          />
        </>
      )}
    </div>
  );
}

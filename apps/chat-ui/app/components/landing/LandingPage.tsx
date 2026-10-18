/**
 * Landing page.
 *
 * The idea: the books, shown working. The page is laid out like the account book it is about:
 * ruled paper, an amber margin line, a double rule under every total. Its centrepiece is a sale
 * you can follow from the shop to the profit figure, and three small instruments built from the
 * real engine (the collection planner, UK corporation tax, the VAT threshold) so a visitor can
 * test the product's claims with their own hands before signing up.
 *
 * Copy rules (design-language.md): plain, specific, honest about limits. Nothing here is a
 * testimonial, a logo wall or an invented statistic; the sample figures are labelled as such.
 */

import { ArrowDown, ArrowRight } from 'phosphor-react';
import { Link } from 'react-router';
import { buttonVariants } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import { DrillSection } from './DrillSection';
import { LandingHeader } from './LandingHeader';
import { Faq, FinalCta, Honest, Jobs, LandingFooter, Sources } from './LandingSections';
import { PlanSimulator } from './PlanSimulator';
import { SaleTracer } from './SaleTracer';
import { TaxSimulator } from './TaxSimulator';

/** A section: an eyebrow, a serif sentence, a short paragraph, then the thing itself. */
function Section({
  id,
  folio,
  eyebrow,
  title,
  lead,
  children,
  tint = false,
}: {
  id?: string;
  folio: string;
  eyebrow: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  children: React.ReactNode;
  tint?: boolean;
}) {
  return (
    <section id={id} className={cn('relative scroll-mt-16 py-20 sm:py-28', tint && 'bg-card/60')}>
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 lg:px-16">
        <div className="eyebrow flex items-center gap-3">
          <span className="font-mono text-accent-text">{folio}</span>
          <span aria-hidden className="h-px w-8 bg-border-strong" />
          {eyebrow}
        </div>
        <h2 className="mt-5 max-w-[860px] font-serif text-[clamp(32px,4.2vw,52px)] font-light leading-[1.06] tracking-[-0.03em] [&_em]:not-italic [&_em]:text-accent-text">
          {title}
        </h2>
        {lead && <p className="mt-5 max-w-[620px] text-[18px] text-text-2">{lead}</p>}
        <div className="mt-12 sm:mt-14">{children}</div>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2"
      >
        Skip to the content
      </a>
      <LandingHeader />

      <main id="main">
        {/* Hero: ruled paper, an amber margin line, and a sale to follow. */}
        <section className="ledger-paper hero-glow relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 hidden w-px bg-ramp-1/45 sm:left-5 lg:left-9 sm:block"
          />
          <div className="mx-auto grid max-w-[1280px] items-center gap-14 px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:px-16">
            <div className="rise">
              <div className="eyebrow">Books for people who make things · UK</div>
              <h1 className="mt-6 font-serif text-[clamp(46px,7vw,92px)] font-light leading-[0.98] tracking-[-0.04em] [&_em]:not-italic [&_em]:text-accent-text">
                Know what you made.
                <br />
                <em>See how we know.</em>
              </h1>
              <p className="mt-7 max-w-[520px] text-[clamp(17px,1.5vw,20px)] text-text-2">
                ThreadWise connects your shop, your payments and your bank, keeps proper
                double-entry books for you, and lets you open any figure down to the orders and bank
                lines behind it.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link to="/signup" className={cn(buttonVariants({ size: 'lg' }), 'gap-2')}>
                  Get started <ArrowRight size={16} weight="bold" aria-hidden />
                </Link>
                <a
                  href="#sale"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-foreground/20 px-6 text-[15px] transition-colors hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Follow a sale <ArrowDown size={14} aria-hidden />
                </a>
              </div>
              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                Shopify · Squarespace · PayPal · Revolut · invoices
              </p>
            </div>
            <div className="flex justify-center lg:justify-end">
              <SaleTracer />
            </div>
          </div>
        </section>

        <Section
          folio="01"
          eyebrow="What you have now"
          title={
            <>
              Your numbers live in three places, and <em>none of them can show their work.</em>
            </>
          }
        >
          <Jobs />
        </Section>

        <Section
          id="sale"
          folio="02"
          eyebrow="Up from one sale, down from one total"
          tint
          title={
            <>
              Open any number. <em>It is made of things you can see.</em>
            </>
          }
          lead="Pick a line of the profit and loss. Underneath is what it is made of, entry by entry, with where each one came from."
        >
          <DrillSection />
        </Section>

        <Section
          id="plan"
          folio="03"
          eyebrow="Plan a drop"
          title={
            <>
              Model it before you make it. <em>Drag the dials.</em>
            </>
          }
          lead="Quantities, costs and sell-through, with a partner if you have one. The profit moves as you do, using the same projection the app runs on a real plan."
        >
          <PlanSimulator />
        </Section>

        <Section
          id="tax"
          folio="04"
          eyebrow="Tax you can see coming"
          tint
          title={
            <>
              Corporation tax by accounting period, and <em>the VAT line before you cross it.</em>
            </>
          }
          lead="Not a surprise in January: the tax on the profit so far, and how close sales are to the point where VAT becomes compulsory."
        >
          <TaxSimulator />
        </Section>

        <Section
          folio="05"
          eyebrow="Where the data comes from"
          title={
            <>
              Connect what you already use. <em>Nothing to retype.</em>
            </>
          }
        >
          <Sources />
        </Section>

        <Section
          id="honest"
          folio="06"
          eyebrow="Straight talk"
          tint
          title={
            <>
              What it does, and <em>where it stops.</em>
            </>
          }
          lead="We would rather you knew the edges before you signed up than found them in March."
        >
          <Honest />
        </Section>

        <Section
          id="faq"
          folio="07"
          eyebrow="Questions"
          title={
            <>
              Things people ask <em>first.</em>
            </>
          }
        >
          <Faq />
        </Section>

        <section className="px-5 pb-20 sm:px-8 sm:pb-28 lg:px-16">
          <div className="mx-auto max-w-[1280px]">
            <FinalCta />
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}

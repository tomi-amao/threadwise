/** The quieter sections of the landing page: the three jobs, sources, straight talk, FAQ, close. */

import { ArrowRight } from 'phosphor-react';
import { Link } from 'react-router';
import { buttonVariants } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import { Wordmark } from './LandingHeader';

const JOBS = [
  {
    n: '01',
    title: 'Dashboards show.',
    body: 'A chart says revenue was £11,500. It cannot say why Tuesday doubled, or whether the figure agrees with the bank.',
  },
  {
    n: '02',
    title: 'Spreadsheets drift.',
    body: 'The export from March. The formula someone fixed in May. By tax time nobody trusts the total, least of all the person who built it.',
  },
  {
    n: '03',
    title: 'Accountants arrive in January.',
    body: 'A year of shoeboxes becomes a bill. You hear about the loss in the same email as the invoice for finding it.',
  },
];

export function Jobs() {
  return (
    <div className="grid gap-10 md:grid-cols-3 md:gap-8">
      {JOBS.map(j => (
        <div key={j.n} className="border-t border-border-strong pt-5">
          <div className="font-mono text-[11px] tracking-[0.08em] text-text-2">{j.n}</div>
          <h3 className="mt-3 font-serif text-[clamp(26px,2.6vw,32px)] leading-[1.08] tracking-[-0.02em]">
            {j.title}
          </h3>
          <p className="mt-3 text-[16px] text-text-2">{j.body}</p>
        </div>
      ))}
    </div>
  );
}

const SOURCES = [
  ['Shopify', 'Orders, products, customers, card fees'],
  ['Squarespace', 'Orders, products, inventory'],
  ['PayPal', 'Transactions and balances'],
  ['Revolut', 'Business transactions and accounts'],
  ['Invoices', 'Upload a PDF and it is read for you. You check it before it counts.'],
];

export function Sources() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-5">
      {SOURCES.map(([name, what]) => (
        <li key={name} className="bg-card px-5 py-6">
          <div className="font-serif text-[26px] leading-none tracking-[-0.02em]">{name}</div>
          <p className="mt-3 text-[14px] text-text-2">{what}</p>
        </li>
      ))}
    </ul>
  );
}

const DOES = [
  [
    'Keeps double-entry books for you',
    'Every entry balances before it posts. A mistake is reversed, never deleted.',
  ],
  ['Shows its working', 'Any figure opens down to the orders, bank lines and journals behind it.'],
  [
    'Asks when it does not know',
    'Money it cannot place becomes a draft. Drafts count in no total until you post them.',
  ],
  [
    'Works out UK tax per period',
    'Corporation tax on your real accounting period, with the VAT threshold watched monthly.',
  ],
];

const DOESNT = [
  [
    'File anything for you',
    'It prepares a CT600 working paper. Filing needs HMRC-recognised software, and your accountant.',
  ],
  [
    'Replace your accountant',
    'It raises the judgement calls, like what is entertainment, and leaves them to you.',
  ],
  ['Cover payroll or other countries', 'UK rules only, for now. Payroll is not part of it.'],
  [
    'Pretend a forecast is a liability',
    'An open period shows a projection, labelled as one, wherever it appears.',
  ],
];

export function Honest() {
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-2">
      <div className="bg-card p-7 sm:p-9">
        <div className="eyebrow">What it does</div>
        <ul className="mt-5 space-y-5">
          {DOES.map(([t, d]) => (
            <li key={t}>
              <div className="font-serif text-[22px] leading-tight tracking-[-0.01em]">{t}</div>
              <p className="mt-1 text-[15px] text-text-2">{d}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-card p-7 sm:p-9">
        <div className="eyebrow">What it does not</div>
        <ul className="mt-5 space-y-5">
          {DOESNT.map(([t, d]) => (
            <li key={t}>
              <div className="font-serif text-[22px] leading-tight tracking-[-0.01em]">
                <span className="text-text-2">Does not </span>
                {t.charAt(0).toLowerCase() + t.slice(1)}
              </div>
              <p className="mt-1 text-[15px] text-text-2">{d}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const FAQ = [
  [
    'Do I need to know accounting?',
    'No. You see sales, costs and profit in plain words, and every accounting term has its meaning one hover away. The double-entry underneath is there so the numbers can be trusted, not so you have to read it.',
  ],
  [
    'Does it replace my accountant?',
    'No, and it is not trying to. It keeps the books tidy and flags the judgement calls (is this entertainment? is that a director’s loan?) so the time you pay an accountant for goes on judgement, not on sorting receipts.',
  ],
  [
    'What does it connect to?',
    'Shopify, Squarespace, PayPal and Revolut Business, plus invoices you upload. Zoho Calendar is optional, to put tax deadlines and collection launch dates in your diary.',
  ],
  [
    'Who can see my data?',
    'You can. Every table of business data sits behind row-level security in the database, so a signed-in person can only ever read their own business. The checks are tested from the outside with a second business in the same database.',
  ],
  [
    'What if something is wrong?',
    'Reverse it. A reversal takes the entry out of every total and keeps it on record, so there is always a trail. Entries in a closed accounting period cannot be quietly changed.',
  ],
  [
    'Is it only for UK businesses?',
    'For now, yes. Corporation tax, VAT and accounting periods follow UK rules, and amounts are in pounds.',
  ],
];

export function Faq() {
  return (
    <div className="divide-y border-y">
      {FAQ.map(([q, a]) => (
        <details key={q} className="group py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-sm font-serif text-[clamp(20px,2vw,24px)] tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {q}
            <span
              aria-hidden
              className="font-mono text-[20px] text-text-2 transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="mt-3 max-w-[680px] text-[16px] text-text-2">{a}</p>
        </details>
      ))}
    </div>
  );
}

export function FinalCta() {
  return (
    <div className="ledger-paper relative overflow-hidden rounded-3xl border border-border-strong bg-card px-6 py-16 text-center sm:px-12 sm:py-24">
      <div className="eyebrow">Close the year</div>
      <h2 className="mx-auto mt-5 max-w-[760px] font-serif text-[clamp(38px,5.4vw,68px)] font-light leading-[1.02] tracking-[-0.035em]">
        Close the books on <em className="not-italic text-accent-text">guessing.</em>
      </h2>
      <p className="mx-auto mt-5 max-w-[480px] text-[17px] text-text-2">
        Connect a store, and read your own numbers with their receipts attached.
      </p>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <Link to="/signup" className={cn(buttonVariants({ size: 'lg' }), 'gap-2')}>
          Get started <ArrowRight size={16} weight="bold" aria-hidden />
        </Link>
        <Link
          to="/login"
          className="inline-flex h-11 items-center rounded-full border border-foreground/20 px-6 text-[15px] hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-6 px-5 py-10 sm:px-8 lg:px-16">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-[420px] font-mono text-[11px] uppercase leading-relaxed tracking-[0.06em] text-muted-foreground">
            Every figure on this page is invented, and labelled as sample. The way they are worked
            out is not.
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-6 text-[15px] text-text-2"
        >
          <Link to="/login" className="hover:text-foreground">
            Sign in
          </Link>
          <Link to="/signup" className="hover:text-foreground">
            Get started
          </Link>
          <a href="#faq" className="hover:text-foreground">
            Questions
          </a>
          <span className="text-muted-foreground">© 2026 ThreadWise</span>
        </nav>
      </div>
    </footer>
  );
}

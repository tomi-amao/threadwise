/**
 * Landing Page Component
 *
 * Public-facing home page describing ThreadWise.
 * Features hero section, features, and call-to-action.
 */

import React from 'react';
import { Link } from 'react-router';
import {
  Sparkle,
  ChatCircle,
  ChartLine,
  Lightning,
  Shield,
  Brain,
  ArrowRight,
  CheckCircle,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';

const features = [
  {
    icon: <ChatCircle size={28} weight="duotone" />,
    title: 'Conversational Analytics',
    description:
      'Ask questions in plain English and get instant answers. No more navigating complex dashboards.',
  },
  {
    icon: <ChartLine size={28} weight="duotone" />,
    title: 'Real-time Insights',
    description:
      'See your financial health at a glance with live KPIs, trends, and automated alerts.',
  },
  {
    icon: <Brain size={28} weight="duotone" />,
    title: 'AI-Powered Analysis',
    description:
      'Our AI understands your business context and provides intelligent recommendations.',
  },
  {
    icon: <Lightning size={28} weight="duotone" />,
    title: 'Instant Reports',
    description: 'Generate income statements, balance sheets, and cash flow reports in seconds.',
  },
  {
    icon: <Shield size={28} weight="duotone" />,
    title: 'Secure by Design',
    description: 'Your data is encrypted and protected. We never share your financial information.',
  },
  {
    icon: <Sparkle size={28} weight="duotone" />,
    title: 'Smart Automation',
    description: 'Automate invoice processing, data extraction, and routine financial tasks.',
  },
];

const benefits = [
  'Replace complex dashboards with simple conversations',
  'Get answers to financial questions in seconds',
  'Track revenue, expenses, and cash flow effortlessly',
  'Upload invoices and let AI extract the data',
  'Monitor business health with real-time indicators',
  'Generate professional reports automatically',
];

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Sparkle size={24} weight="duotone" className="text-primary" />
              </div>
              <span className="text-xl font-bold text-foreground">ThreadWise</span>
            </div>

            <div className="flex items-center gap-3">
              <Link to="/login">
                <Button variant="ghost" size="sm">
                  Sign in
                </Button>
              </Link>
              <Link to="/signup">
                <Button size="sm" className="gap-2">
                  Get started
                  <ArrowRight size={16} />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center max-w-4xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-8">
              <Sparkle size={18} weight="fill" />
              AI-Powered Business Intelligence
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground leading-tight mb-6">
              Talk to your data,
              <br />
              <span className="text-primary">not dashboards</span>
            </h1>

            <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
              ThreadWise replaces complex business dashboards with natural conversations. Ask
              questions about your finances, get instant insights, and make smarter decisions.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/signup">
                <Button size="lg" className="gap-2 text-lg px-8">
                  Start for free
                  <ArrowRight size={20} />
                </Button>
              </Link>
              <Link to="/login">
                <Button variant="outline" size="lg" className="text-lg px-8">
                  Sign in
                </Button>
              </Link>
            </div>
          </div>

          {/* Hero Visual */}
          <div className="mt-20 relative">
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent z-10" />
            <div className="rounded-2xl border border-border bg-card/50 backdrop-blur-sm p-4 sm:p-8 shadow-2xl">
              <div className="rounded-xl bg-muted/30 border border-border p-6 sm:p-8">
                {/* Simulated chat interface */}
                <div className="space-y-4">
                  <div className="flex items-start gap-3 justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-3 max-w-md">
                      <p className="text-sm">What was our revenue last month?</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                      <Sparkle size={18} className="text-primary" />
                    </div>
                    <div className="bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3 max-w-lg">
                      <p className="text-sm text-foreground">
                        Your revenue for December 2025 was <strong>$127,450</strong>, which
                        represents a
                        <span className="text-green-500 font-medium"> 12.3% increase</span> compared
                        to November. The growth was primarily driven by the new product launch.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-3 max-w-md">
                      <p className="text-sm">Show me a breakdown by product category</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-muted/20">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-6">
                Everything you need to understand your business
              </h2>
              <p className="text-lg text-muted-foreground mb-8">
                ThreadWise combines the power of AI with your financial data to give you
                unprecedented visibility into your business performance.
              </p>

              <ul className="space-y-4">
                {benefits.map((benefit, index) => (
                  <li key={index} className="flex items-start gap-3">
                    <CheckCircle
                      size={24}
                      weight="duotone"
                      className="text-primary shrink-0 mt-0.5"
                    />
                    <span className="text-foreground">{benefit}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Stats cards */}
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-3xl font-bold text-primary mb-2">10x</p>
                <p className="text-sm text-muted-foreground">Faster than manual reporting</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-3xl font-bold text-primary mb-2">24/7</p>
                <p className="text-sm text-muted-foreground">AI available anytime</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-3xl font-bold text-primary mb-2">100%</p>
                <p className="text-sm text-muted-foreground">Secure & encrypted</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-3xl font-bold text-primary mb-2">∞</p>
                <p className="text-sm text-muted-foreground">Questions you can ask</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
              Powerful features for modern businesses
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              From real-time analytics to automated reporting, ThreadWise has everything you need to
              stay on top of your finances.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => (
              <div
                key={index}
                className="rounded-xl border border-border bg-card p-6 hover:border-primary/50 transition-colors"
              >
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-4">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">{feature.title}</h3>
                <p className="text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <div className="rounded-2xl bg-gradient-to-br from-primary/20 via-primary/10 to-background border border-primary/20 p-8 sm:p-12 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
              Ready to transform how you understand your business?
            </h2>
            <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
              Join businesses that have already switched from complex dashboards to conversational
              intelligence with ThreadWise.
            </p>
            <Link to="/signup">
              <Button size="lg" className="gap-2 text-lg px-8">
                Get started for free
                <ArrowRight size={20} />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkle size={18} weight="duotone" className="text-primary" />
            </div>
            <span className="font-semibold text-foreground">ThreadWise</span>
          </div>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} ThreadWise. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * Auth Layout Component
 *
 * Layout for authentication pages (login, signup).
 * Centers the auth form with decorative background.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router';
import { useAuth } from '~/providers/AuthProvider';
import { Sparkle, SpinnerGap } from 'phosphor-react';
import { Link } from 'react-router';

export function AuthLayout() {
  const { user, loading } = useAuth();

  // Show loading state while checking authentication
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <SpinnerGap size={48} className="animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Redirect to dashboard if already authenticated
  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Left side - decorative */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary/20 via-background to-background relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,transparent_0%,transparent_49%,rgba(255,255,255,0.02)_50%,transparent_51%,transparent_100%)] bg-[length:100px_100px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,transparent_49%,rgba(255,255,255,0.02)_50%,transparent_51%,transparent_100%)] bg-[length:100px_100px]" />

        <div className="relative z-10 flex flex-col justify-center px-12 xl:px-20">
          <Link to="/" className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center">
              <Sparkle size={28} weight="duotone" className="text-primary" />
            </div>
            <span className="text-2xl font-bold text-foreground">ThreadWise</span>
          </Link>

          <h2 className="text-4xl xl:text-5xl font-bold text-foreground mb-6 leading-tight">
            Your AI-powered
            <br />
            <span className="text-primary">business intelligence</span>
            <br />
            companion
          </h2>

          <p className="text-lg text-muted-foreground max-w-md">
            Replace complex dashboards with natural conversations. Ask questions, get insights, and
            make informed decisions faster.
          </p>

          <div className="mt-12 space-y-4">
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span className="text-primary font-bold text-sm">1</span>
              </div>
              <span>Connect your financial data</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span className="text-primary font-bold text-sm">2</span>
              </div>
              <span>Ask questions in plain English</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span className="text-primary font-bold text-sm">3</span>
              </div>
              <span>Get actionable insights instantly</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right side - auth form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <Outlet />
      </div>
    </div>
  );
}

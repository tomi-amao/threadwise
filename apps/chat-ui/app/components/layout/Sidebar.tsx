/**
 * Sidebar Navigation Component
 *
 * Vertical navigation menu for authenticated users.
 * Provides access to key sections: Dashboard, Chat, Invoices, Reports, and Account.
 * Supports collapsible mode - showing only icons when collapsed.
 */

import React from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  ChartLine,
  ChatCircle,
  FileText,
  ChartBar,
  PlugsConnected,
  User,
  SignOut,
  X,
  Sparkle,
  CaretLeft,
  CaretRight,
} from 'phosphor-react';
import { useAuth } from '~/providers/AuthProvider';
import { useSidebar } from '~/providers/SidebarProvider';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
  onClick?: () => void;
}

function NavItem({ to, icon, label, collapsed, onClick }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3',
          isActive
            ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-md'
            : 'text-sidebar-foreground/70'
        )
      }
    >
      {icon}
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const { profile, entity, signOut } = useAuth();
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useSidebar();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const closeMobile = () => setMobileOpen(false);

  const navContent = (
    <>
      {/* Logo / Brand */}
      <div className={cn('border-b border-sidebar-border', collapsed ? 'p-3' : 'p-6')}>
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'gap-3')}>
          <div className="w-10 h-10 rounded-xl bg-sidebar-primary/10 flex items-center justify-center shrink-0">
            <Sparkle size={24} weight="duotone" className="text-sidebar-primary" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="font-bold text-lg text-sidebar-foreground">ThreadWise</h1>
              <p className="text-xs text-sidebar-foreground/60 truncate max-w-[140px]">
                {entity?.name || 'Your Business'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
        <div className="mb-4">
          {!collapsed && (
            <p className="px-4 py-2 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
              Overview
            </p>
          )}
          <NavItem
            to="/dashboard"
            icon={<ChartLine size={20} weight="duotone" />}
            label="Dashboard"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/chat"
            icon={<ChatCircle size={20} weight="duotone" />}
            label="Ask AI"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        <div className="mb-4">
          {!collapsed && (
            <p className="px-4 py-2 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
              Finance
            </p>
          )}
          <NavItem
            to="/invoices"
            icon={<FileText size={20} weight="duotone" />}
            label="Invoices"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/reports"
            icon={<ChartBar size={20} weight="duotone" />}
            label="Financial Reports"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        {/* Integrations Section */}
        <div className="mb-4">
          {!collapsed && (
            <p className="px-4 py-2 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
              Data Sources
            </p>
          )}
          <NavItem
            to="/integrations"
            icon={<PlugsConnected size={20} weight="duotone" />}
            label="Integrations"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>
      </nav>

      {/* User Section */}
      <div className="p-4 border-t border-sidebar-border">
        <NavItem
          to="/account"
          icon={<User size={20} weight="duotone" />}
          label="Account"
          collapsed={collapsed}
          onClick={closeMobile}
        />
        <button
          onClick={handleSignOut}
          title={collapsed ? 'Sign out' : undefined}
          className={cn(
            'w-full flex items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200',
            'text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive',
            collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3'
          )}
        >
          <SignOut size={20} weight="duotone" />
          {!collapsed && <span>Sign out</span>}
        </button>

        {/* Collapse Toggle Button (Desktop only) */}
        <button
          onClick={toggleCollapsed}
          className={cn(
            'hidden lg:flex w-full items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200 mt-2',
            'text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3'
          )}
        >
          {collapsed ? (
            <CaretRight size={20} weight="duotone" />
          ) : (
            <CaretLeft size={20} weight="duotone" />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 lg:hidden" onClick={closeMobile} />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-50 h-screen bg-sidebar border-r border-sidebar-border',
          'flex flex-col transition-all duration-300 ease-in-out',
          'lg:translate-x-0',
          collapsed ? 'w-[72px]' : 'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          className
        )}
      >
        {navContent}
      </aside>
    </>
  );
}

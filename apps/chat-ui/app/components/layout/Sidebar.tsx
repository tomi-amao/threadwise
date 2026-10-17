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
  ArrowsLeftRight,
  PlugsConnected,
  User,
  SignOut,
  Sparkle,
  CaretLeft,
  CaretRight,
  ShoppingCart,
  Package,
  Users,
  Wrench,
  BookOpen,
  Scales,
  StackSimple,
} from 'phosphor-react';
import { useAuth } from '~/providers/AuthProvider';
import { useSidebar } from '~/providers/SidebarProvider';
import { ThemeToggle } from '~/components/ui/theme-toggle';
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
          'relative flex items-center gap-3 rounded-xl text-sm font-medium transition-colors duration-200',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary'
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
  const { entity, signOut } = useAuth();
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
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-sidebar-border bg-background">
            <Sparkle size={22} weight="light" className="text-accent-text" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-lg font-medium tracking-tight text-sidebar-foreground">
                ThreadWise
              </p>
              <p className="max-w-[140px] truncate text-xs text-muted-foreground">
                {entity?.name || 'Your Business'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
        <div className="mb-4">
          {!collapsed && <p className="eyebrow px-4 py-2">Overview</p>}
          <NavItem
            to="/dashboard"
            icon={<ChartLine size={20} weight="light" />}
            label="Dashboard"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/chat"
            icon={<ChatCircle size={20} weight="light" />}
            label="Ask AI"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        <div className="mb-4">
          {!collapsed && <p className="eyebrow px-4 py-2">Finance</p>}
          <NavItem
            to="/invoices"
            icon={<FileText size={20} weight="light" />}
            label="Invoices"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/transactions"
            icon={<ArrowsLeftRight size={20} weight="light" />}
            label="Transactions"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/reports"
            icon={<ChartBar size={20} weight="light" />}
            label="Financial Reports"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/journals"
            icon={<BookOpen size={20} weight="light" />}
            label="Journal Entries"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/tax"
            icon={<Scales size={20} weight="light" />}
            label="Tax"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        {/* Commerce Section */}
        <div className="mb-4">
          {!collapsed && <p className="eyebrow px-4 py-2">Commerce</p>}
          <NavItem
            to="/orders"
            icon={<ShoppingCart size={20} weight="light" />}
            label="Orders"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/products"
            icon={<Package size={20} weight="light" />}
            label="Products"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/collections"
            icon={<StackSimple size={20} weight="light" />}
            label="Collections"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/inventory"
            icon={<Package size={20} weight="fill" />}
            label="Inventory"
            collapsed={collapsed}
            onClick={closeMobile}
          />
          <NavItem
            to="/customers"
            icon={<Users size={20} weight="light" />}
            label="Customers"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        {/* Tools Section */}
        <div className="mb-4">
          {!collapsed && <p className="eyebrow px-4 py-2">Tools</p>}
          <NavItem
            to="/reclassification"
            icon={<Wrench size={20} weight="light" />}
            label="Reclassification"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>

        {/* Data Sources Section */}
        <div className="mb-4">
          {!collapsed && <p className="eyebrow px-4 py-2">Data Sources</p>}
          <NavItem
            to="/integrations"
            icon={<PlugsConnected size={20} weight="light" />}
            label="Integrations"
            collapsed={collapsed}
            onClick={closeMobile}
          />
        </div>
      </nav>

      {/* User Section */}
      <div className="p-4 border-t border-sidebar-border">
        <div className={cn('mb-3 flex', collapsed ? 'justify-center' : 'px-1')}>
          <ThemeToggle compact={collapsed} />
        </div>
        <NavItem
          to="/account"
          icon={<User size={20} weight="light" />}
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
          <SignOut size={20} weight="light" />
          {!collapsed && <span>Sign out</span>}
        </button>

        {/* Collapse Toggle Button (Desktop only) */}
        <button
          onClick={toggleCollapsed}
          className={cn(
            'hidden lg:flex w-full items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200 mt-2',
            'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3'
          )}
        >
          {collapsed ? (
            <CaretRight size={20} weight="light" />
          ) : (
            <CaretLeft size={20} weight="light" />
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
        <div className="fixed inset-0 z-50 bg-foreground/40 lg:hidden" onClick={closeMobile} />
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

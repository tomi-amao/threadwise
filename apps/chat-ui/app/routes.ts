import { type RouteConfig, route, layout, index } from '@react-router/dev/routes';

/**
 * Application Routes Configuration
 *
 * Public routes:
 * - / (landing page)
 * - /login (auth)
 * - /signup (auth)
 *
 * Protected routes (require authentication):
 * - /dashboard
 * - /chat
 * - /invoices
 * - /reports
 * - /integrations
 * - /account
 */
export default [
  // Public landing page
  index('routes/_index.tsx'),

  // Auth routes (login, signup) - use auth layout
  layout('routes/auth.tsx', [
    route('login', 'routes/auth.login.tsx'),
    route('signup', 'routes/auth.signup.tsx'),
  ]),

  // Protected app routes - use app layout with sidebar
  layout('routes/app.tsx', [
    route('dashboard', 'routes/app.dashboard.tsx'),
    route('chat', 'routes/app.chat.tsx'),
    route('invoices', 'routes/app.invoices.tsx'),
    route('transactions', 'routes/app.transactions.tsx'),
    route('collections', 'routes/app.collections.tsx'),
    route('collections/:collectionId', 'routes/app.collection-detail.tsx'),
    route('reports', 'routes/app.reports.tsx'),
    route('orders', 'routes/app.orders.tsx'),
    route('products', 'routes/app.products.tsx'),
    route('inventory', 'routes/app.inventory.tsx'),
    route('customers', 'routes/app.customers.tsx'),
    route('integrations', 'routes/app.integrations.tsx'),
    route('account', 'routes/app.account.tsx'),
    route('journals', 'routes/app.journals.tsx'),
    route('tax', 'routes/app.tax.tsx'),
    // Design-system gallery: development and tests only, never shipped.
    ...(process.env.NODE_ENV === 'production' ? [] : [route('ui-kit', 'routes/app.ui-kit.tsx')]),
  ]),

  // API routes
  route('api/invoices', 'routes/api.invoices.tsx'),
  route('api/orders', 'routes/api.orders.tsx'),
  route('api/customers', 'routes/api.customers.tsx'),
  route('api/products', 'routes/api.products.tsx'),
  route('api/inventory', 'routes/api.inventory.tsx'),
  route('api/reports/account-drilldown', 'routes/api.reports.account-drilldown.tsx'),
  route('api/reports/cash-flow-pack', 'routes/api.reports.cash-flow-pack.tsx'),
  route('api/tax/ct600-pack', 'routes/api.tax.ct600-pack.tsx'),
  route('api/collections/plan-pack', 'routes/api.collections.plan-pack.tsx'),
  route('api/collections/transactions', 'routes/api.collections.transactions.tsx'),
] satisfies RouteConfig;

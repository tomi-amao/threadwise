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
    route('reports', 'routes/app.reports.tsx'),
    route('orders', 'routes/app.orders.tsx'),
    route('products', 'routes/app.products.tsx'),
    route('inventory', 'routes/app.inventory.tsx'),
    route('customers', 'routes/app.customers.tsx'),
    route('integrations', 'routes/app.integrations.tsx'),
    route('account', 'routes/app.account.tsx'),
    route('reclassification', 'routes/app.reclassification.tsx'),
    route('journals', 'routes/app.journals.tsx'),
    route('tax', 'routes/app.tax.tsx'),
  ]),

  // API routes
  route('api/invoices', 'routes/api.invoices.server.tsx'),
  route('api/reclassification', 'routes/api.reclassification.server.tsx'),
  route('api/journals', 'routes/api.journals.server.tsx'),
  route('api/inventory', 'routes/api.inventory.server.tsx'),
  route('api/reports/account-drilldown', 'routes/api.reports.account-drilldown.server.tsx'),
  route('api/reports/cash-flow-pack', 'routes/api.reports.cash-flow-pack.server.tsx'),
  route('api/tax/ct600-pack', 'routes/api.tax.ct600-pack.server.tsx'),
] satisfies RouteConfig;

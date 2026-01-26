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
    route('reports', 'routes/app.reports.tsx'),
    route('account', 'routes/app.account.tsx'),
  ]),

  // API routes
  route('api/invoices', 'routes/api.invoices.server.tsx'),
] satisfies RouteConfig;

import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { Toaster } from 'sonner';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { AuthProvider } from '~/providers/AuthProvider';
import { ThemeProvider, useTheme } from '~/providers/ThemeProvider';
import { DEFAULT_THEME, parseTheme } from '~/lib/theme';
import { shouldRevalidateLayout } from '~/lib/layout-revalidate';
import './globals.css';

export const shouldRevalidate = shouldRevalidateLayout;

export function loader({ request }: LoaderFunctionArgs) {
  return { theme: parseTheme(request.headers.get('cookie')) };
}

/** Sonner needs the theme at render time; this reads it from the provider. */
function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster position="top-center" richColors theme={theme} className="toaster group" />;
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Loader data is undefined when an error boundary renders the layout; fall back to light.
  const data = useRouteLoaderData<typeof loader>('root');
  const theme = data?.theme ?? DEFAULT_THEME;

  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : undefined}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="font-sans">
        <ThemeProvider initialTheme={theme}>
          <AuthProvider>{children}</AuthProvider>
          <ThemedToaster />
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

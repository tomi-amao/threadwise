import { vercelPreset } from '@vercel/react-router/vite';
import type { Config } from '@react-router/dev/config';

export default {
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // Vercel sets VERCEL=1 while building. The preset replaces the build output
  // (no build/server/index.js), so everywhere else (Docker, `pnpm start`) skips it.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;

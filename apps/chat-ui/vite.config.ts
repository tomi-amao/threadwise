import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths(), tailwindcss(), devtoolsJson()],
  server: {
    port: 5174,
    host: true,
  },
  // The SDK ships a nested ESM copy of p-retry with no package.json, so a plain `.js` file with
  // `import` statements. Node 24 sniffs that fine, but Vercel's function loader does not and the
  // SSR render crashes ("Cannot use import statement outside a module"). Bundling it avoids the
  // runtime resolution altogether.
  ssr: {
    noExternal: ['@langchain/langgraph-sdk'],
  },
});

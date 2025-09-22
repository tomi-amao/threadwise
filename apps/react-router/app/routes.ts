import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('test-chat', 'routes/test-chat.tsx'),
] satisfies RouteConfig;

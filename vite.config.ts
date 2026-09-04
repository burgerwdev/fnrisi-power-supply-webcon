import { defineConfig } from 'vitest/config';
import pkg from './package.json';

// 版本号单一来源:package.json,构建时注入,前端不再多处写死。
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

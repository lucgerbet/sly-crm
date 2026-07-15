import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_TARGET || 'http://localhost:3003';

  return {
    plugins: [react()],
    server: {
      port: 5175,
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
  };
});

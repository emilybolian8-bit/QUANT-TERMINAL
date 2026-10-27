import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // The reference liquidation_heatmap.html is a design doc, not app code: a
      // foreign program holding it open makes chokidar throw EBUSY, and that
      // unhandled watcher error takes the whole dev server down.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : { ignored: ['**/liquidation_heatmap.html'] },
    },
  };
});

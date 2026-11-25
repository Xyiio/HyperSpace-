import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built app also works from a sub-path or a static host.
export default defineConfig({ plugins: [react()], base: './' });

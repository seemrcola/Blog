import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: 'https://seemrcola.github.io',
  base: '/Blog',
  markdown: {
    shikiConfig: {
      theme: 'vitesse-light',
    },
  },
});

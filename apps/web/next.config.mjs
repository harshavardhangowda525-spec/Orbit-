import { fileURLToPath } from 'node:url';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compile the shared package from its ES module source so unused parts
  // (phone metadata, templates, plans) are tree-shaken out of the browser bundle.
  webpack(config) {
    config.resolve.alias['@orbit/shared$'] = sharedSrc;
    return config;
  },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@orbit/shared'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
        ],
      },
    ];
  },
};
export default nextConfig;

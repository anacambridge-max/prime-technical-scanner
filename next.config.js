/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep server-only secrets (UPSTOX_ACCESS_TOKEN) out of client bundles.
  // Nothing here is prefixed with NEXT_PUBLIC_, so env vars stay server-side by default.
};

module.exports = nextConfig;

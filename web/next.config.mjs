/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "127.0.0.1" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  // Audit FSEC-002: every Arcade route is a wallet-signing surface, so
  // refuse to be framed by any origin. DENY + frame-ancestors none is the
  // belt-and-braces combination - browsers that ignore one honour the
  // other. Without these headers an attacker hosts `evil.com` with our
  // page in a 0-opacity iframe and overlays a fake "Click to claim
  // airdrop" button on top of our Confirm Swap; the user-visible wallet
  // popup tells the truth, but the dApp-side framing context primes the
  // user to misread it.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // MetaMask SDK has a soft dep on the React Native AsyncStorage that we
    // don't use in the browser bundle. Alias it to false so webpack stops
    // trying to resolve it. Same trick the wagmi / RainbowKit docs recommend.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;

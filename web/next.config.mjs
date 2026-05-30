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

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@adhoc/shared"],
  serverExternalPackages: ["pg", "pg-native"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;

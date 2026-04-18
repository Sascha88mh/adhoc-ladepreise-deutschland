import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@adhoc/shared"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;

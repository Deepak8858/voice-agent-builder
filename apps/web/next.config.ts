import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Required for Azure App Service container deployment
  // Standalone output creates a minimal server.js in .next/standalone
};

export default nextConfig;

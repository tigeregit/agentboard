import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is opened from localhost or the machine's own IP; allow those for dev HMR/RSC requests.
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is opened from localhost or the machine's own IP; allow those for dev HMR/RSC requests.
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],

  // The dashboard is only ever served over loopback or a LAN, where gzip
  // buys nothing but CPU time. Turning compression off also works around a
  // Next.js <=16.3.x bug (vercel/next.js#97698, fixed in 16.4.0-canary.10):
  // on every backpressured write the vendored `compression` middleware leaks
  // one `drain` listener onto its Gzip stream, which logs
  // "MaxListenersExceededWarning: ... 11 drain listeners added to [Gzip]".
  compress: false,
};

export default nextConfig;

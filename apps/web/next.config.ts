import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // A self-contained server for the container image. The trace is taken from the repository root.
  output: "standalone",
  outputFileTracingRoot: join(here, "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
  // Headers that stop the desk being framed by another site (a decision button under a hidden page), guessed at as
  // another type, or sending its address on to other sites. The content security policy limits only what cannot
  // break the page: framing, base address, forms and plug-ins.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default config;

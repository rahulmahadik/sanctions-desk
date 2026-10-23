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
};

export default config;

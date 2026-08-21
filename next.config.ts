import type { NextConfig } from "next";

/**
 * COOP/COEP make the site cross-origin isolated, which is required for
 * SharedArrayBuffer and therefore for multi-threaded Stockfish (spec §3.1).
 * Without these headers the engine silently falls back to single-thread and
 * batch analysis becomes ~40x slower.
 *
 * Consequence: COEP `require-corp` blocks any cross-origin subresource that
 * does not send CORP/CORS headers. Fonts are system-stack, images and engine
 * assets are self-hosted under /public. Any future external image or embed
 * must be proxied through a route handler.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;

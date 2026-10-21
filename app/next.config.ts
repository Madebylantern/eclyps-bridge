import type { NextConfig } from "next";

/**
 * Static export (Vercel or any static host). Everything runs in the browser: the Solana wallet
 * signs locally, and the Aztec PXE (private state, proofs) runs in-page as WASM, so there is no
 * team server on the critical path (SPEC §4.3). COOP/COEP enable SharedArrayBuffer for the
 * multithreaded prover; `next dev` sets them here, production sets them in vercel.json.
 */
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

const dev = process.env.NODE_ENV !== "production";

const config: NextConfig = {
  // Static export for production; `next dev` needs no export and serves the isolation headers.
  ...(dev ? {} : { output: "export" as const }),
  reactStrictMode: true,
  // `/` is the landing and `/app` the app. Export each route as a folder with its own index.html
  // (out/app/index.html), which any static host serves at /app/.
  trailingSlash: true,
  transpilePackages: ["@eclyps/sdk", "@eclyps/aztec-contracts"],
  ...(dev ? { async headers() { return [{ source: "/:path*", headers: isolation }]; } } : {}),
  webpack(cfg, { isServer, webpack }) {
    cfg.experiments = { ...cfg.experiments, asyncWebAssembly: true, topLevelAwait: true, layers: true };
    // Workspace TS sources use NodeNext-style ".js" specifiers.
    cfg.resolve.extensionAlias = { ...cfg.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    if (!isServer) {
      // Aztec libraries reach for a few Node built-ins; give the browser polyfills or empty stubs.
      cfg.resolve.fallback = {
        ...cfg.resolve.fallback,
        buffer: "buffer/",
        process: "process/browser",
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        worker_threads: false,
        os: false,
        path: false,
        crypto: false,
        stream: false,
        zlib: false,
        http: false,
        https: false,
        url: false,
        util: false,
        assert: false,
        events: false,
        string_decoder: false,
      };
      cfg.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"], process: "process/browser" }),
        // "node:x" specifiers -> "x" so the fallbacks above apply.
        new webpack.NormalModuleReplacementPlugin(/^node:/, (r: { request: string }) => {
          r.request = r.request.replace(/^node:/, "");
        }),
      );
    }
    return cfg;
  },
};

export default config;

/**
 * Build + deploy tooling for the plugin.
 *
 *   node build.mjs          # one-shot build -> dist/<slug>/
 *   node build.mjs --serve  # build, watch, serve locally (for build checks only)
 *
 * Output layout (what Revenge installs, and what GitHub Pages hosts):
 *   dist/
 *     MessageLoggerRevenge/
 *       manifest.json   # generated: main="index.js" + content hash
 *       index.js        # the bundled plugin
 *
 * Once deployed to GitHub Pages, the install URL is:
 *   https://<user>.github.io/<repo>/MessageLoggerRevenge/
 *
 * NOTE: Revenge fetches the manifest through a remote relay, which cannot reach
 * localhost or a LAN IP — so the local --serve mode is only useful for verifying
 * the build produces valid output, NOT for installing on-device. Install from
 * the GitHub Pages URL instead (see SETUP-GITHUB-PAGES.md).
 */

import { build, context } from "esbuild";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serve = process.argv.includes("--serve");
const PORT = 4040;

// The plugin "slug" — the subfolder name under dist/ and in the install URL.
// Must match the manifest name for tidiness; change both together if renamed.
const SLUG = "MessageLoggerRevenge";
const DIST = path.join(__dirname, "dist");
const OUT_DIR = path.join(DIST, SLUG);

function writeManifest() {
  const src = JSON.parse(
    fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")
  );
  const bundle = fs.readFileSync(path.join(OUT_DIR, "index.js"));
  const hash = crypto
    .createHash("sha256")
    .update(bundle)
    .digest("hex")
    .slice(0, 12);
  const out = { ...src, main: "index.js", hash };
  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(out, null, 2)
  );
  return hash;
}

const manifestPlugin = {
  name: "manifest",
  setup(b) {
    b.onEnd((result) => {
      if (result.errors.length) return;
      // Guard: Revenge's Hermes engine rejects async ARROW functions at parse
      // time ("async functions are unsupported"), which bricks the whole plugin.
      // async function expressions/methods are fine. Fail the build if an async
      // arrow slipped into the output so it can never ship silently broken.
      const out = fs.readFileSync(path.join(OUT_DIR, "index.js"), "utf8");
      const asyncArrow = /async\s*\([^)]*\)\s*=>|async\s+[A-Za-z_$][\w$]*\s*=>/;
      if (asyncArrow.test(out)) {
        throw new Error(
          "Build blocked: async arrow function found in output. " +
            "Hermes can't parse `async () => {}` — rewrite it as " +
            "`async function () {}`."
        );
      }
      const hash = writeManifest();
      console.log(`manifest.json written (hash ${hash})`);
    });
  },
};

const common = {
  entryPoints: [path.join(__dirname, "src/index.tsx")],
  bundle: true,
  format: "cjs",
  // es2021 keeps async/await native (Hermes supports it). Classes are avoided
  // entirely in source (Hermes rejects class expressions), so no class lowering
  // is needed. Do not raise to esnext — that reintroduces class-field risk if a
  // class ever creeps back in.
  target: "es2021",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  // The client loader provides these at runtime; keep them out of the bundle so
  // they compile to require("@vendetta/...") calls the loader resolves.
  external: ["@vendetta", "@vendetta/*"],
  outfile: path.join(OUT_DIR, "index.js"),
  plugins: [manifestPlugin],
  logLevel: "info",
  legalComments: "none",
};

async function once() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await build(common);
  console.log(`Built dist/${SLUG}/`);
}

async function watchAndServe() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ctx = await context(common);
  await ctx.watch();
  console.log("Watching src/ for changes…");

  http
    .createServer((req, res) => {
      // Serve dist/ so /<slug>/manifest.json resolves like the Pages layout.
      let rel = req.url === "/" ? `/${SLUG}/manifest.json` : req.url;
      const file = path.join(DIST, path.normalize(rel));
      if (!file.startsWith(DIST)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": file.endsWith(".json")
            ? "application/json"
            : "application/javascript",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
      });
    })
    .listen(PORT, "0.0.0.0", () => {
      console.log(`\nLocal check server: http://127.0.0.1:${PORT}/${SLUG}/`);
      console.log("(local install won't work — see the note in this file)\n");
    });
}

if (serve) await watchAndServe();
else await once();

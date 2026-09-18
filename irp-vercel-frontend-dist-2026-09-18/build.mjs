import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("./dist/", import.meta.url);
const staticFiles = [
  "index.html",
  "app.js",
  "api-client.js",
  "data-adapter.js",
  "renderers.js",
  "styles.css",
  "favicon.svg"
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: ["auth-client-source.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  outfile: "dist/auth-client.js"
});

await Promise.all(
  staticFiles.map((file) => copyFile(new URL(file, import.meta.url), new URL(file, outputDirectory)))
);

#!/usr/bin/env node
/**
 * Runs ONLY on Vercel (via the `vercel-build` script).
 * Swaps the web entry so the marketing landing owns "/" on the website,
 * while the app moves to /app. The local `npm run build` never runs this,
 * so Capacitor's dist/index.html stays the app for iOS/Android bundles.
 *
 *   dist/index.html (app)  -> dist/app.html
 *   dist/home.html (landing) -> dist/index.html
 */
import { renameSync, copyFileSync, existsSync } from "node:fs";

if (!process.env.VERCEL) {
  console.log("Not on Vercel — skipping entry swap (Capacitor build keeps app at index.html).");
  process.exit(0);
}
if (!existsSync("dist/index.html") || !existsSync("dist/home.html")) {
  throw new Error("dist/index.html or dist/home.html missing — build order wrong?");
}
renameSync("dist/index.html", "dist/app.html");
copyFileSync("dist/home.html", "dist/index.html");
console.log("Vercel entry swap done: / = landing, /app = app.");

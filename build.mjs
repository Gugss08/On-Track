// Gera a pasta dist/ pronta a publicar: node build.mjs
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const V = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/main.js"], bundle: true, minify: true, format: "esm", target: ["safari15", "chrome100"], outfile: "dist/app.js", legalComments: "none" });
cpSync("public", "dist", { recursive: true });
cpSync("src/styles.css", "dist/styles.css");
for (const f of ["index.html", "sw.js"]) {
  const src = f === "index.html" ? "src/index.html" : "dist/sw.js";
  writeFileSync("dist/" + f, readFileSync(src, "utf8").replaceAll("__V__", V));
}
writeFileSync("dist/.nojekyll", "");
console.log("dist/ pronto, versão", V);

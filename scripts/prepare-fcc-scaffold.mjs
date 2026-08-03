import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scaffoldRoot = path.resolve(process.env.FCE_SCAFFOLD_DIR || path.join(repositoryRoot, "..", "fce-extension-scaffold"));
const sourceRoot = path.join(repositoryRoot, "fcc", "live");
const destinationRoot = path.join(scaffoldRoot, "typescript", "src", "app");

const files = ["config.ts", "handlers.ts", "main.ts"];
const importRewrites = [
  ["../../../fce-extension-scaffold/typescript/src/base/types.js", "../base/types.js"],
  ["../../../fce-extension-scaffold/typescript/src/base/server.js", "../base/server.js"]
];

for (const file of files) {
  const source = path.join(sourceRoot, file);
  const destination = path.join(destinationRoot, file);
  let contents = await readFile(source, "utf8");
  for (const [from, to] of importRewrites) contents = contents.replaceAll(from, to);
  await writeFile(destination, contents);
  console.log(`prepared ${path.relative(scaffoldRoot, destination)}`);
}

await copyFile(path.join(sourceRoot, "README.md"), path.join(scaffoldRoot, "docs", "prime-server-fcc.md"));
console.log(`scaffold=${scaffoldRoot}`);

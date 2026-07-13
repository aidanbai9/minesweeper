import { mkdir, readdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "engine", "src");
const target = path.join(root, "client", "engine");

await mkdir(target, { recursive: true });
const files = await readdir(source);

await Promise.all(
  files
    .filter((file) => file.endsWith(".js"))
    .map((file) => copyFile(path.join(source, file), path.join(target, file)))
);

console.log(`synced engine/src -> client/engine (${files.filter((file) => file.endsWith(".js")).length} files)`);

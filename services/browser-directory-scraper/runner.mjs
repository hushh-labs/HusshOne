import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const workers = [
  ["01", "healthcare", 9222],
  ["02", "insurance", 9223],
  ["03", "advisory", 9224],
  ["04", "all", 9225],
];
const children = new Map();
let stopping = false;

function start([id, vertical, port]) {
  const env = {
    ...process.env,
    WORKER_ID: `browser-${id}`,
    WORKER_VERTICAL: vertical,
    CDP_PORT: String(port),
    WORKER_PROFILE_DIR: process.env[`CHROME_PROFILE_${id}`] || "",
  };
  const child = spawn(process.execPath, [path.join(root, "worker.mjs")], { env, stdio: "inherit", windowsHide: true });
  children.set(id, child);
  child.on("exit", (code, signal) => {
    children.delete(id);
    console.log(JSON.stringify({ event: "worker.exit", id, code, signal }));
    if (!stopping) setTimeout(() => start([id, vertical, port]), 5000);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true;
  for (const child of children.values()) child.kill(signal);
});

console.log(JSON.stringify({ event: "fleet.started", workers: workers.map(([id, vertical, port]) => ({ id, vertical, port })) }));
for (const worker of workers) start(worker);

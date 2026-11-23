import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { coordinatorSource, leaveCoordinator, reportReady } from "../../src/workers.ts";

const [out, mode] = process.argv.slice(2);
const id = Number(process.env.CTXLIFT_WORKER);
const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
const source = coordinatorSource(new Map(keys.map((k) => [k, { key: k } as never])));
if (mode === "fail-before-ready" && id === 2) process.exit(3);
reportReady();
let n = 0;
for (;;) {
  const item = (await source.next()) as { key: string } | null;
  if (!item) break;
  // crash in the middle of this worker's second run, so that run is lost
  if (mode === "crash" && id === 1 && ++n === 2) process.exit(1);
  // blocks the way a docker client does; only a signal to the whole process group ends it early
  if (mode === "block") {
    process.on("SIGINT", () => process.exit(130));
    // the child writes the marker itself, so the test only signals once the child is in the process group; a plain process rather than a shell, which can let a SIGINT pass between two commands
    const child = `require("node:fs").writeFileSync(process.argv[1], ""); setTimeout(() => {}, 30_000);`;
    spawnSync(process.execPath, ["-e", child, `${out}.started`]);
  }
  await new Promise((r) => setTimeout(r, 40));
  appendFileSync(out, `${id} ${item.key}\n`);
  source.done?.(item as never);
}
leaveCoordinator();

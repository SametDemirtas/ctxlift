import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a real process with the same kind of handler and synchronous children, then SIGINT mid-step: the flag must be visible at the next check
test("a SIGINT during a synchronous step is seen right after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-signal-"));
  try {
    const script = join(dir, "loop.ts");
    writeFileSync(
      script,
      `import { spawnSync } from "node:child_process";
       import { yieldToEvents } from ${JSON.stringify(new URL("../src/events.ts", import.meta.url).pathname)};
       let stop = false;
       process.on("SIGINT", () => { stop = true; });
       let done = 0;
       for (let i = 0; i < 5; i++) {
         await yieldToEvents();
         if (stop) break;
         if (i === 0) process.kill(process.pid, "SIGINT");
         spawnSync("sleep", ["0.2"]);
         done++;
       }
       console.log(done);`,
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "1", "stopped after the step that was running when the signal came");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

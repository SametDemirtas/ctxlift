import type { Outcome } from "../types.ts";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ENTITIES[m.toLowerCase()],
  );
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : "";
}

export function parseJUnit(xml: string): Map<string, Outcome> {
  const tests = new Map<string, Outcome>();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const inner = m[3] ?? "";
    if (/<skipped\b/.test(inner)) continue;
    const id = `${attr(attrs, "classname")}::${attr(attrs, "name")}`;
    const outcome: Outcome = /<(failure|error)\b/.test(inner) ? "fail" : "pass";
    // a test reported twice (e.g. call passed, teardown errored) counts as failed
    tests.set(id, tests.get(id) === "fail" ? "fail" : outcome);
  }
  return tests;
}

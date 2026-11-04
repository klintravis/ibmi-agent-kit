// The run report: one self-contained HTML file per session, a block per step (what the agent did and
// why, and the screen it left), so a human can review a fast or headless run afterwards.
// Plain HTML and inline CSS, no script and no external resource. A report never fails a session:
// every problem is a warning and the report stops.

import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitWorkTree } from "@ibmi-agent-kit/core";
import { frameOf, SCREEN_CSS } from "./render.js";
import type { ScreenBuffer } from "./screen.js";

export interface RunReport {
  path: string;
  step(screen: ScreenBuffer, label: string): void;
  test(name: string, passed: boolean, failures: string[]): void;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_") || "x";

const PAGE_CSS = `:root { color-scheme: dark; }
  body { margin:0; background:#0b0f0b; color:#9fc09f; font:14px/1.35 "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace; }
  header { padding:8px 12px; background:#111a11; border-bottom:1px solid #234023; color:#e8e8e8; }
  header span { color:#7fa07f; font-size:12px; margin-left:12px; }
  section { padding:14px; border-top:1px solid #234023; }
  .bar { margin-bottom:8px; font-size:12px; }
  .bar b { color:#e8e8e8; font-size:13px; }
  .scroll { overflow-x:auto; }
  .test.pass { border-left:4px solid #33ff44; }
  .test.fail { border-left:4px solid #ff4d4d; }
  .test b { color:#e8e8e8; }
  .test li { color:#ff4d4d; }
  ${SCREEN_CSS}`;

// shortcut: no size cap and no retention, a long headless run grows the file by one screen per step
// and old reports stay until the user deletes them; upgrade to a per-session cap or a retention
// setting when reports pile up.
export function openReport(
  dir: string,
  server: string,
  session: string,
  warn: (message: string) => void,
): RunReport | undefined {
  let path: string;
  try {
    const folder = resolve(dir);
    const tree = gitWorkTree(folder);
    if (tree) {
      warn(`run report not written: ${folder} is inside the git work tree ${tree}, and a report holds screen contents. Point IBMI_5250_REPORT_DIR outside it.`);
      return undefined;
    }
    mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const base = `${stamp}_${safe(server)}_${safe(session)}`;
    let fd: number | undefined;
    for (let n = 1; fd === undefined; n++) {
      path = join(folder, `${base}${n > 1 ? `_${n}` : ""}.html`);
      try {
        fd = openSync(path, "wx", 0o600); // wx: never overwrites
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 999) throw e;
      }
    }
    const title = `5250 run report: ${server} [${session}]`;
    writeSync(
      fd,
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title>\n<style>\n  ${PAGE_CSS}\n</style></head>\n<body>\n` +
        `<header><b>${esc(title)}</b><span>started ${esc(new Date().toLocaleString())}</span></header>\n`,
    );
    closeSync(fd);
  } catch (e) {
    warn(`run report not written: ${(e as Error).message}`);
    return undefined;
  }

  // The document is never closed: a browser renders it as is, so a run that dies midway still reads.
  let broken = false;
  const append = (html: string) => {
    if (broken) return;
    try {
      appendFileSync(path, html);
    } catch (e) {
      broken = true;
      warn(`run report stopped: ${(e as Error).message}`);
    }
  };
  let n = 0;
  return {
    path: path!,
    step(screen, label) {
      const f = frameOf(screen); // already escaped, hidden fields blank
      append(
        `<section><div class="bar"><b>${++n}</b> &middot; ${esc(new Date().toLocaleTimeString())} &middot; ${esc(label)}</div>` +
          `<div class="scroll"><div class="screen">${f.rows}</div></div><div class="oia">${f.oia}</div></section>\n`,
      );
    },
    test(name, passed, failures) {
      append(
        `<section class="test ${passed ? "pass" : "fail"}"><b>${passed ? "PASS" : "FAIL"}</b> ${esc(name)}` +
          (failures.length ? `<ul>${failures.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : "") +
          `</section>\n`,
      );
    },
  };
}

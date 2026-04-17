/**
 * Terminal UI — minimal, Apple-inspired.
 */

import pc from "picocolors";
export { pc };

export const clr = () => process.stdout.write("\r\x1b[K");
export const showCursor = () => process.stdout.write("\x1b[?25h");
export const hideCursor = () => process.stdout.write("\x1b[?25l");

export function header() {
  console.log();
  console.log(pc.bold("  ar-en-simul") + pc.dim(" — Arabic → English simultaneous interpreter"));
  console.log();
}

export function connecting(service: string) {
  process.stdout.write(pc.dim(`  Connecting to ${service}...`));
}

export function connected(service: string) {
  clr();
  console.log(pc.dim(`  ✓ ${service}`));
}

export function connectFailed(service: string, hint?: string) {
  clr();
  console.log(pc.red(`  ✗ ${service}`) + (hint ? pc.dim(` — ${hint}`) : ""));
}

export function ready(mode: string) {
  console.log();
  console.log("  " + pc.green(`● ${mode}`) + "  •  " + pc.dim("q to quit"));
  console.log();
  hideCursor();
}

let dotFrame = 0;
const dots = ["·", "•", "●", "•"];

export function listening() {
  clr();
  process.stdout.write(`  ${pc.green(dots[dotFrame++ % dots.length])} ${pc.dim("Listening")}`);
}

export function speaking() {
  clr();
  process.stdout.write(pc.magenta("  ♪ ") + pc.dim("Speaking"));
}

export function speechDetected() {
  clr();
  process.stdout.write(pc.yellow("  ● ") + pc.dim("Hearing speech..."));
}

export function translating() {
  clr();
  process.stdout.write(pc.yellow("  ◐ ") + pc.dim("Translating"));
}

export function error(msg: string) {
  clr();
  console.log(pc.red("  ✗ ") + pc.dim(msg));
}

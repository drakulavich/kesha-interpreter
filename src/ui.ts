import pc from "picocolors";
export { pc };

export const clr = () => process.stdout.write("\r\x1b[K");
export const showCursor = () => process.stdout.write("\x1b[?25h");
export const hideCursor = () => process.stdout.write("\x1b[?25l");

export function header() {
  console.log();
  console.log(pc.bold("  kesha-interpreter") + pc.dim(" — Arabic → English"));
  console.log();
}

export function ready(mode: string) {
  console.log(pc.dim(`  ${mode}`));
  console.log();
  hideCursor();
}

export function error(msg: string) {
  console.log(pc.red(`  ✗ `) + pc.dim(msg));
}

export function recording() {
  clr();
  process.stdout.write(pc.dim("  Recording..."));
}

export function translating() {
  clr();
  process.stdout.write(pc.dim("  Translating..."));
}

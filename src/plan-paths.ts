import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
export const plansDirectory = join(projectDirectory, "plans");

function isBareName(path: string): boolean {
  return path !== "." && path !== ".." && !path.includes("/") && !path.includes("\\");
}

/** Bare plan names always live in the project's plans/ directory, regardless of cwd. */
export function planOutputPath(path: string): string {
  return isBareName(path) ? join(plansDirectory, path) : resolve(path);
}

export async function preparePlanOutput(path: string): Promise<string> {
  const resolved = planOutputPath(path);
  if (dirname(resolved) === plansDirectory) await mkdir(plansDirectory, { recursive: true, mode: 0o700 });
  return resolved;
}

/** Existing project-root plans remain readable by bare name after moving defaults to plans/. */
export async function planInputPath(path: string): Promise<string> {
  if (!isBareName(path)) return resolve(path);
  const selected = join(plansDirectory, path);
  try { await access(selected); return selected; }
  catch { /* Check saved plans from earlier versions in the project root. */ }
  const legacy = join(projectDirectory, path);
  try { await access(legacy); return legacy; }
  catch { return selected; }
}

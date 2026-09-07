import fs from "node:fs";
import readline from "node:readline";

/**
 * Read a JSONL file tolerantly: skips blank/malformed lines (a torn final
 * line is common for append-only logs written by a live agent).
 */
export async function readJsonl<T = unknown>(
  file: string,
  opts: { maxLines?: number; maxLineBytes?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (opts.maxLineBytes && line.length > opts.maxLineBytes) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn or malformed line */
    }
    n++;
    if (opts.maxLines && n >= opts.maxLines) break;
  }
  return out;
}

export function parseJsonlText<T = unknown>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function readJsonSafe<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

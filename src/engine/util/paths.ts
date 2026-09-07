import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function home(): string {
  return process.env.AGENTBOARD_FAKE_HOME || os.homedir();
}

export function expand(p: string): string {
  if (p.startsWith("~")) return path.join(home(), p.slice(1));
  return p;
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Platform-specific "application data" roots for VS Code style apps. */
export function appDataRoots(appName: string): string[] {
  const h = home();
  const roots: string[] = [];
  if (process.platform === "darwin") {
    roots.push(path.join(h, "Library", "Application Support", appName));
  } else if (process.platform === "win32") {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, appName));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(h, ".config");
    roots.push(path.join(xdg, appName));
  }
  // Always also probe the non-native locations so remote / synced homes work.
  roots.push(path.join(h, ".config", appName));
  roots.push(path.join(h, "Library", "Application Support", appName));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, appName));
  return Array.from(new Set(roots));
}

export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
}

export function agentboardHome(): string {
  const dir = process.env.AGENTBOARD_HOME || path.join(home(), ".agentboard");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Recursively list files under `root` matching `predicate`. */
export function walk(
  root: string,
  predicate: (fullPath: string, name: string) => boolean,
  opts: { maxDepth?: number; skipDirs?: (name: string) => boolean } = {},
): string[] {
  const out: string[] = [];
  const maxDepth = opts.maxDepth ?? 8;
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (opts.skipDirs?.(e.name)) continue;
        visit(full, depth + 1);
      } else if (e.isFile() && predicate(full, e.name)) {
        out.push(full);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Decode the "cwd with separators replaced by dashes" encoding used by Claude
 * Code, pi, Cursor CLI, WorkBuddy, DeepSeek Harness, ... The encoding is lossy
 * (a dash in a directory name is indistinguishable from a separator) so the
 * result is a best-effort display path.
 */
export function decodeDashedCwd(encoded: string): string {
  let s = encoded;
  if (s.startsWith("--") && s.endsWith("--")) s = s.slice(2, -2);
  if (/^[A-Za-z]--/.test(s)) {
    // Windows drive letter: C--Users-me -> C:/Users/me
    return s[0] + ":/" + s.slice(3).replace(/-/g, "/");
  }
  if (s.startsWith("-")) return s.replace(/-/g, "/");
  return "/" + s.replace(/-/g, "/");
}

export function projectFromPath(p: string | undefined | null): { path: string; name: string } {
  if (!p) return { path: "(unknown)", name: "(unknown)" };
  const clean = p.replace(/[\\/]+$/, "");
  const name = clean.split(/[\\/]/).filter(Boolean).pop() || clean;
  return { path: clean || p, name };
}

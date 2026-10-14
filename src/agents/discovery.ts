import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code names a project's transcript dir after the launch cwd with every non-alphanumeric char turned into '-'. */
export function claudeProjectDirName(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Transcript files (.jsonl) for this project modified within `sinceMs`, newest first. */
export function findClaudeSessions(
  root: string,
  claudeDir: string = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
  sinceMs = 600_000,
  now: number = Date.now(),
): string[] {
  const roots = new Set<string>([path.resolve(root)]);
  try { roots.add(fs.realpathSync(root)); } catch { /* root may not exist */ }
  const found = new Map<string, number>();
  for (const r of roots) {
    const dir = path.join(claudeDir, 'projects', claudeProjectDirName(r));
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && now - st.mtimeMs <= sinceMs) found.set(file, st.mtimeMs);
      } catch { /* vanished */ }
    }
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/**
 * `livemap sn install-plugin [--uninstall]`: copies LiveMap's SkyForge plugin into `~/.skyforge/plugin/`, or
 * removes it. It touches that one file only, and only after an explicit yes at a prompt. SkyForge's own
 * config and install are never changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PLUGIN_FILE = 'livemap-skyforge.js';
export const INSTALL_USAGE = 'Usage: livemap sn install-plugin [--uninstall]';

/** Where SkyForge loads plugins from: `~/.skyforge/plugin/` (on Windows, `C:\Users\<user>\.skyforge\plugin\`). */
export const pluginDir = (home: string = os.homedir()): string => path.join(home, '.skyforge', 'plugin');
export const pluginTarget = (home?: string): string => path.join(pluginDir(home), PLUGIN_FILE);

/** The built plugin, next to the CLI bundle (`dist/livemap-skyforge.js`). */
export const pluginSource = (): string => path.join(path.dirname(fileURLToPath(import.meta.url)), PLUGIN_FILE);

/** Asks a yes/no question on the terminal; anything but y or yes (or no answer) is no. */
export function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(/^\s*y(es)?\s*$/i.test(a)); });
    rl.on('close', () => { if (!answered) resolve(false); });
  });
}

export interface InstallOptions {
  home?: string;
  source?: string;
  ask?: (question: string) => Promise<boolean>;
  say?: (line: string) => void;
}

/** Returns the exit code: 0 done or nothing to do, 1 refused or failed. */
export async function installPlugin(argv: string[], o: InstallOptions = {}): Promise<number> {
  const say = o.say ?? ((l: string) => process.stdout.write(`${l}\n`));
  const ask = o.ask ?? askYesNo;
  let uninstall = false;
  for (const a of argv) {
    if (a === '--uninstall') uninstall = true;
    else if (a === '-h' || a === '--help') { say(INSTALL_USAGE); return 0; }
    else { process.stderr.write(`livemap sn install-plugin: unknown option: ${a}\n${INSTALL_USAGE}\n`); return 1; }
  }
  const target = pluginTarget(o.home);
  if (uninstall) {
    if (!fs.existsSync(target)) { say(`The plugin is not installed (${target}).`); return 0; }
    say(`This removes LiveMap's SkyForge plugin:\n  ${target}\nNothing else is changed.`);
    if (!(await ask('Remove it? [y/N] '))) { say('Nothing removed.'); return 0; }
    try { fs.unlinkSync(target); } catch (e) { process.stderr.write(`livemap sn install-plugin: could not remove ${target}: ${(e as Error).message}\n`); return 1; }
    say('Removed. Restart SkyForge so it stops loading the plugin.');
    return 0;
  }
  const source = o.source ?? pluginSource();
  let code: Buffer;
  try { code = fs.readFileSync(source); } catch {
    process.stderr.write(`livemap sn install-plugin: the plugin file is missing (${source}). Run npm run build.\n`);
    return 1;
  }
  const skyforge = path.dirname(pluginDir(o.home));
  if (!fs.existsSync(skyforge)) {
    process.stderr.write(`livemap sn install-plugin: SkyForge's folder was not found (${skyforge}). Start SkyForge once, then try again.\n`);
    return 1;
  }
  let same = false;
  try { same = fs.readFileSync(target).equals(code); } catch { /* not installed yet */ }
  if (same) { say(`The plugin is already installed and up to date:\n  ${target}`); return 0; }
  say(`This copies LiveMap's SkyForge plugin to:\n  ${target}\nSkyForge loads every file in that folder when it starts. Nothing else is changed.`);
  if (!(await ask('Copy it? [y/N] '))) { say('Nothing copied.'); return 0; }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
  } catch (e) {
    process.stderr.write(`livemap sn install-plugin: could not write ${target}: ${(e as Error).message}\n`);
    return 1;
  }
  say('Copied. Restart SkyForge to load it.');
  return 0;
}

export async function runInstallPlugin(argv: string[]): Promise<void> {
  process.exitCode = await installPlugin(argv);
}

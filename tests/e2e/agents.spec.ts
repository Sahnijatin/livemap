import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const CLI = path.join(root, 'dist/cli.js');
const SERVICE = 'server/services/orderService.ts';
const SESSION = 'e2e-claude-session';
const PROMPT = 'Add a refund endpoint';
const MESSAGE = "I'll add refund to the order service";
const NOTE = 'Use the existing db helper';
const PAUSE = 'The user paused this session in LiveMap. Stop and wait for their instructions.';

let tmp: string;
let home: string;
let claudeDir: string;
let proc: ChildProcess | undefined;
let url: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=LiveMap E2E', '-c', 'user.email=e2e@livemap.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: tmp, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function startCli(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, dir, '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p; // assigned up front so afterAll can always kill it
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`CLI did not print a URL:\n${out}`)); }, 20_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited early (${code}):\n${out}`)); });
  });
}

/** The command `livemap init` configured for one agent event, read from the generated config file. */
function hookCommand(agent: 'claude' | 'codex' | 'cursor', event: string): string {
  const file = { claude: '.claude/settings.local.json', codex: '.codex/hooks.json', cursor: '.cursor/hooks.json' }[agent];
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, file), 'utf8')) as { hooks: Record<string, unknown[]> };
  const entries = cfg.hooks[event];
  expect(entries, `${file} has no ${event} hook`).toBeTruthy();
  const commands = agent === 'cursor'
    ? (entries as { command: string }[]).map(e => e.command)
    : (entries as { hooks: { command: string }[] }[]).flatMap(g => g.hooks.map(h => h.command));
  const cmd = commands.find(c => c.includes('livemap-hook.mjs'));
  expect(cmd, `${file} ${event} has no LiveMap command`).toBeTruthy();
  return cmd!;
}

interface HookRun { code: number | null; stdout: string; stderr: string }

/** Runs the configured hook command through a shell, exactly as the agent would, with the payload on stdin. */
function runHook(agent: 'claude' | 'codex' | 'cursor', event: string, payload: object): Promise<HookRun> {
  const command = hookCommand(agent, event);
  return new Promise((resolve, reject) => {
    const p = spawn(command, { shell: true, cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`hook ${agent} ${event} did not exit`)); }, 10_000);
    p.stdout!.on('data', (b: Buffer) => { stdout += b.toString(); });
    p.stderr!.on('data', (b: Buffer) => { stderr += b.toString(); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    p.stdin!.end(JSON.stringify(payload));
  });
}

const tplLines = (): string[] => fs.readFileSync(path.join(root, 'tests/fixtures/agents/e2e-claude.jsonl.tpl'), 'utf8').split('\n').filter(Boolean);
/** Template line `i` rendered with the current time (backfill drops entries older than 10 minutes). */
const render = (i: number): string =>
  `${tplLines()[i].replaceAll('__NOW__', new Date().toISOString()).replaceAll('__SESSION__', SESSION).replaceAll('__ROOT__', tmp)}\n`;

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-agents-e2e-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-home-')));
  claudeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-claude-')));
  // `node` in hook commands must resolve to this Node.
  env = {
    ...process.env,
    LIVEMAP_HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  fs.cpSync(path.join(root, 'tests/fixtures/shop'), tmp, { recursive: true });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial shop');
  execFileSync(process.execPath, [CLI, 'init', tmp, '--agents', 'claude,codex,cursor'], { env, stdio: 'pipe' });
  expect(fs.existsSync(path.join(home, 'bin/livemap-hook.mjs'))).toBe(true);
  url = await startCli(tmp);
});

test.afterAll(async () => {
  const p = proc;
  if (p && p.exitCode === null && p.signalCode === null) {
    const exited = new Promise<void>(r => p.once('exit', () => r()));
    p.kill('SIGTERM');
    const killer = setTimeout(() => p.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }
  for (const d of [tmp, home, claudeDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const feed = (page: Page) => page.getByRole('main', { name: 'Activity' });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const chip = (page: Page, name: string) => page.getByRole('list', { name: 'Agents' }).getByRole('listitem').filter({ hasText: name });

test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });

test('agent flow: transcript, attribution, flags, pause, cursor and git', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({ timeout: 15_000 });

  // 3. Claude Code: transcript with a prompt and a message, announced by the UserPromptSubmit hook.
  const transcript = path.join(claudeDir, 'projects', tmp.replace(/[^a-zA-Z0-9]/g, '-'), 's1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, render(0) + render(1));
  const claudeBase = { session_id: SESSION, transcript_path: transcript, cwd: tmp };
  const t0 = Date.now();
  const submit = await runHook('claude', 'UserPromptSubmit', { ...claudeBase, hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
  expect(submit).toEqual({ code: 0, stdout: '', stderr: '' });
  await expect(feed(page).locator('.f-prompt')).toContainText(PROMPT, { timeout: 2000 });
  const msg = feed(page).locator('.f-msg');
  await expect(msg).toBeVisible({ timeout: 2000 });
  expect(Date.now() - t0).toBeLessThanOrEqual(2000);
  // A live message types itself out over about 1.2 s; compare the paragraph (not the avatar) once typing ends.
  const prose = msg.locator('.prose');
  await expect(prose).toHaveClass(/\btyping\b/);
  await expect(prose).not.toHaveClass(/\btyping\b/, { timeout: 5000 });
  await expect(prose.locator('p')).toHaveText(MESSAGE);
  await expect(chip(page, 'Claude Code')).toBeVisible();
  await page.screenshot({ path: 'test-results/agents-dark-1-claude-feed.png' });

  // 4. The agent edits the file: change card with refund, exact attribution, and why it changed.
  fs.appendFileSync(transcript, render(2));
  const file = path.join(tmp, SERVICE);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('export async function listOrders', 'export function refund(id: string) {}\n\nexport async function listOrders'));
  const card = feed(page).locator('.f-chg').filter({ hasText: SERVICE });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.locator('.facts')).toContainText('refund');
  await expect(card.locator('.ag-badge.exact')).toHaveText(/Claude Code · exact/, { timeout: 6000 });
  await card.locator('.ch').click();
  const insp = inspector(page);
  await expect(insp.getByRole('heading', { name: 'orderService.ts' })).toBeVisible();
  const why = insp.locator('.sec', { has: page.getByRole('heading', { name: 'Why it changed' }) });
  await expect(why.locator('q')).toHaveText(MESSAGE);
  await expect(why).toContainText('by Claude Code');
  await page.screenshot({ path: 'test-results/agents-dark-2-attribution.png' });

  // 5. Flag the file; the next Claude PreToolUse is blocked with the note and the UI shows it delivered.
  await insp.getByRole('textbox', { name: 'Flag note for this file' }).fill(NOTE);
  await insp.getByRole('button', { name: 'Flag', exact: true }).click();
  await expect(insp.locator('.fstate')).toHaveText("Waiting for the agent's next action");
  const tool = { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } };
  const flagged = await runHook('claude', 'PreToolUse', { ...claudeBase, hook_event_name: 'PreToolUse', ...tool, tool_use_id: 'e2e-tu2' });
  expect(flagged.code).toBe(2);
  expect(flagged.stderr).toContain('The user flagged this in LiveMap:');
  expect(flagged.stderr).toContain(`- ${SERVICE}: ${NOTE}`);
  await expect(insp.locator('.fstate')).toContainText('Delivered', { timeout: 5000 });
  await expect(insp.locator('.fstate')).toContainText('to Claude Code');
  // Claude Code records the blocked call in its transcript as a tool_use with an is_error result.
  fs.appendFileSync(transcript, render(3) + render(4));
  const blockedEdit = feed(page).locator('.f-tool.failed').filter({ hasText: 'Edit server/services/orderService.ts' });
  await expect(blockedEdit).toBeVisible({ timeout: 3000 });
  await expect(blockedEdit.getByRole('status')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/agents-dark-3-flag-delivered.png' });

  // 6. Pause blocks Codex; Resume lets the next action through.
  const codexBase = { session_id: 'e2e-codex-session', transcript_path: null, cwd: tmp, hook_event_name: 'PreToolUse', model: 'gpt-5', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const pause = page.getByRole('button', { name: 'Pause agent' });
  await pause.click();
  const resume = page.getByRole('button', { name: 'Resume agent' });
  await expect(resume).toHaveAttribute('aria-pressed', 'true');
  const blocked = await runHook('codex', 'PreToolUse', { ...codexBase, tool_use_id: 'e2e-cx1' });
  expect(blocked.code).toBe(2);
  expect(blocked.stderr.trim()).toBe(PAUSE);
  await page.screenshot({ path: 'test-results/agents-dark-4-paused.png' });
  await resume.click();
  await expect(page.getByRole('button', { name: 'Pause agent' })).toHaveAttribute('aria-pressed', 'false');
  const allowed = await runHook('codex', 'PreToolUse', { ...codexBase, tool_use_id: 'e2e-cx2' });
  expect(allowed).toEqual({ code: 0, stdout: '', stderr: '' });
  await expect(chip(page, 'Codex')).toBeVisible();

  // 7. Cursor: an agent response shows as a message with a Cursor chip.
  const cursorText = 'Cursor checked the refund flow';
  const cur = await runHook('cursor', 'afterAgentResponse', {
    conversation_id: 'e2e-cursor-conv', generation_id: 'g1', hook_event_name: 'afterAgentResponse',
    workspace_roots: [tmp], transcript_path: null, model: 'auto', text: cursorText,
  });
  expect(cur).toEqual({ code: 0, stdout: '', stderr: '' });
  await expect(feed(page).locator('.f-msg').filter({ hasText: cursorText })).toBeVisible({ timeout: 4000 });
  await expect(chip(page, 'Cursor')).toBeVisible();

  // 8. A commit in the repo shows as a git commit card within 5 s.
  git('add', SERVICE);
  git('commit', '-q', '-m', 'Add refund endpoint');
  await expect(feed(page).locator('.f-git').filter({ hasText: 'Add refund endpoint' })).toBeVisible({ timeout: 5000 });
  // A merge folds into one compact line; the Live session lists the real commit, not the merge.
  git('checkout', '-q', '-b', 'e2e-feature');
  git('commit', '-q', '--allow-empty', '-m', 'Feature work');
  git('checkout', '-q', '-');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from acme/e2e-feature', 'e2e-feature');
  await expect(feed(page).locator('.f-git.merge').filter({ hasText: 'Merge pull request #12' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '‹ Live session' }).click();
  const commits = page.locator('.gitlist .gitrow');
  await expect(commits.first()).toContainText('Feature work');
  await expect(commits.filter({ hasText: 'Merge pull request' })).toHaveCount(0);

  // 9. Dark-mode screenshots of the final state.
  await page.screenshot({ path: 'test-results/agents-dark-5-final.png' });
  await page.getByRole('list', { name: 'Agents' }).screenshot({ path: 'test-results/agents-dark-chips.png' });
  await feed(page).screenshot({ path: 'test-results/agents-dark-feed.png' });
});

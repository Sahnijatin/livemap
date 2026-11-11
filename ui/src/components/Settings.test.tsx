// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsView } from '@shared/settings.js';
import { useStore } from '../store';

vi.mock('../api', () => ({ getSettings: vi.fn(), saveAiSettings: vi.fn(), saveGuardrails: vi.fn() }));
const api = await import('../api');
const { default: Settings } = await import('./Settings');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const off: SettingsView = { version: '0.3.0', configFile: '/home/me/.livemap/config.json', ai: { enabled: false, active: false, keySource: 'none' } };
const on: SettingsView = { ...off, ai: { enabled: true, active: true, provider: 'anthropic', model: 'claude-haiku-5-5', keySource: 'config' } };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = async (view: SettingsView) => {
  vi.mocked(api.getSettings).mockResolvedValue(view);
  act(() => root.render(<Settings />));
  await flush();
};
const field = (label: string) => [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))!.querySelector('input,select,textarea') as HTMLInputElement;
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ settingsOpen: true });
  vi.mocked(api.saveAiSettings).mockReset();
  vi.mocked(api.saveGuardrails).mockReset();
  vi.mocked(api.saveGuardrails).mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Settings', () => {
  it('turns AI on with a provider and key, and clears the key field after saving', async () => {
    await mount(off);
    vi.mocked(api.saveAiSettings).mockResolvedValue(on);
    const sw = host.querySelector('input[aria-label="AI summaries and Ask"]') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    act(() => sw.click());
    type(field('API key'), 'sk-123');
    await act(async () => { button('Save').click(); });
    await flush();
    expect(api.saveAiSettings).toHaveBeenCalledWith({ enabled: true, provider: 'anthropic', model: '', url: '', apiKey: 'sk-123' });
    expect(field('API key').value).toBe('');
    expect(host.textContent).toContain('On: anthropic, claude-haiku-5-5');
    expect(host.textContent).not.toContain('sk-123');
  });

  it('keeps a saved key when the field is left blank, and can remove it', async () => {
    await mount(on);
    vi.mocked(api.saveAiSettings).mockResolvedValue(on);
    expect(field('API key').placeholder).toMatch(/A key is saved/);
    await act(async () => { button('Save').click(); });
    expect(vi.mocked(api.saveAiSettings).mock.calls[0][0]).not.toHaveProperty('apiKey');
    await act(async () => { button('Remove saved key').click(); });
    expect(vi.mocked(api.saveAiSettings).mock.calls[1][0]).toMatchObject({ apiKey: null });
  });

  it('shows why a save failed', async () => {
    await mount(off);
    vi.mocked(api.saveAiSettings).mockRejectedValue(new Error('Choose a provider'));
    await act(async () => { button('Save').click(); });
    await flush();
    expect(host.querySelector('.set-err')?.textContent).toBe('Choose a provider');
  });

  it('adds, disables and removes guardrail rules, saving the whole list each time', async () => {
    await mount(off);
    type(field('File patterns') as unknown as HTMLTextAreaElement, 'db/migrations/**\n.env*');
    type(field('Message for the agent'), 'Ask first.');
    await act(async () => { button('Add rule').click(); });
    await flush();
    const rule = { paths: ['db/migrations/**', '.env*'], commands: [], action: 'block', on: 'write', message: 'Ask first.' };
    expect(api.saveGuardrails).toHaveBeenLastCalledWith([rule]);
    const sw = host.querySelector('.set-rules input[role="switch"]') as HTMLInputElement;
    await act(async () => { sw.click(); });
    await flush();
    expect(api.saveGuardrails).toHaveBeenLastCalledWith([{ ...rule, enabled: false }]);
    await act(async () => { (host.querySelector('.set-x') as HTMLButtonElement).click(); });
    await flush();
    expect(api.saveGuardrails).toHaveBeenLastCalledWith([]);
  });

  it('Esc closes the dialog', async () => {
    await mount(off);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(useStore.getState().settingsOpen).toBe(false);
  });
});

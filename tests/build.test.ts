import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usePrebuilt } from './build.js';

const BUILT = ['dist/cli.js', 'dist/ui/index.html', 'dist/ui-export/index.html'];

describe('usePrebuilt (LIVEMAP_TEST_PREBUILT)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-prebuilt-'));
    for (const f of BUILT) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses an existing build when LIVEMAP_TEST_PREBUILT=1', () => {
    expect(usePrebuilt(dir, { LIVEMAP_TEST_PREBUILT: '1' })).toBe(true);
  });

  it('builds when the variable is not set', () => {
    expect(usePrebuilt(dir, {})).toBe(false);
  });

  it.each(BUILT)('builds when %s is missing', f => {
    fs.rmSync(path.join(dir, f));
    expect(usePrebuilt(dir, { LIVEMAP_TEST_PREBUILT: '1' })).toBe(false);
  });
});

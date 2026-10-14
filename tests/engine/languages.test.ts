import { describe, it, expect } from 'vitest';
import { langOf, isBinaryPath, isSecretEnvPath, GRAMMAR } from '../../src/engine/languages.js';

describe('languages', () => {
  it('classifies by extension and name', () => {
    expect(langOf('src/App.tsx')).toBe('tsx');
    expect(langOf('a/b.mts')).toBe('typescript');
    expect(langOf('main.py')).toBe('python');
    expect(langOf('lib/main.dart')).toBe('dart');
    expect(langOf('Component.vue')).toBe('vue');
    expect(langOf('prisma/schema.prisma')).toBe('prisma');
    expect(langOf('.env')).toBe('secret');
    expect(langOf('.env.production')).toBe('secret');
    expect(langOf('.env.example')).toBe('text');
    expect(langOf('Dockerfile')).toBe('other');
  });
  it('detects binary paths', () => {
    expect(isBinaryPath('logo.PNG')).toBe(true);
    expect(isBinaryPath('db.sqlite3')).toBe(true);
    expect(isBinaryPath('src/index.ts')).toBe(false);
  });
  it('detects secret env paths', () => {
    expect(isSecretEnvPath('.env')).toBe(true);
    expect(isSecretEnvPath('apps/web/.env.local')).toBe(true);
    expect(isSecretEnvPath('.env.sample')).toBe(false);
    expect(isSecretEnvPath('.env.template')).toBe(false);
    expect(isSecretEnvPath('.ENV')).toBe(true);
    expect(isSecretEnvPath('.envrc')).toBe(true);
    expect(isSecretEnvPath('app/.ENVRC')).toBe(true);
    expect(isSecretEnvPath('cfg/.Env.Local')).toBe(true);
    expect(isSecretEnvPath('.ENV.EXAMPLE')).toBe(false);
    expect(langOf('.ENV')).toBe('secret');
  });
  it('treats editor backups and dash/underscore variants of .env as secret', () => {
    for (const p of ['.env~', 'cfg/.env.local~', '#.env#', 'cfg/#.env.local#', '.env-prod', '.ENV-Staging', '.env_local', '.Env_Dev']) {
      expect(isSecretEnvPath(p), p).toBe(true);
      expect(langOf(p), p).toBe('secret');
    }
    for (const p of ['.env-example', '.env_sample', '.environment.ts', 'env-prod']) expect(isSecretEnvPath(p), p).toBe(false);
  });
  it('C1: Windows backslash paths are classified by their base name', () => {
    for (const p of ['C:\\p\\.env', '..\\.env', '.\\.env.local', 'cfg\\.envrc']) expect(isSecretEnvPath(p), p).toBe(true);
    expect(isSecretEnvPath('C:\\p\\.env.example')).toBe(false);
  });
  it('C1: .envrc variants are secret, their examples are not', () => {
    for (const p of ['.envrc.local', 'cfg/.envrc-prod', '.ENVRC_dev']) expect(isSecretEnvPath(p), p).toBe(true);
    for (const p of ['.envrc.example', '.envrc-sample', '.envrcx']) expect(isSecretEnvPath(p), p).toBe(false);
  });
  it('treats suffixed *.env variants as secret, but not examples or code files', () => {
    for (const p of ['config/prod.env.local', 'staging.env.bak', 'Prod.ENV.Local', 'app.env-old', '.envrc.local']) {
      expect(isSecretEnvPath(p), p).toBe(true);
    }
    for (const p of ['prod.env.json', 'secrets.env.yaml', 'staging.env.sh', 'prod.env.txt', 'app.env.toml']) {
      expect(isSecretEnvPath(p), p).toBe(true);
    }
    for (const p of ['deploy.env.md', 'prod.env.html', 'prod.env.css', 'prod.env.sql']) expect(isSecretEnvPath(p), p).toBe(false);
    // Source code is code whatever its name (LiveMap serves settings.py too), in any language it parses.
    for (const p of ['example.env', 'sample.env', 'app.template.env', 'prod.env.example', 'config.env.ts', 'app.env.js', 'vite.env.d.ts', 'app.env.example.json', '.env.example.json', '.env.d.ts', 'config.env.py', 'settings.env.go', 'a.env.java', 'x.env.vue', 'x.env.rs', 'production.env.php']) {
      expect(isSecretEnvPath(p), p).toBe(false);
    }
  });
  it('keeps secret: .env.* JS files, names that merely contain example words, and credential rc variants', () => {
    for (const p of ['.env.js', '.env.local.js', '.env.production.mjs', 'email-template.env', 'example-api.env', 'sample_app.env', '.env.example.local', '.npmrc.bak', '.netrc.old', '.pypirc.local', 'sample.env.local', 'example.env.production', 'example.env.local.json', 'sample.env.prod.yaml', '.env.production.d.ts', '.env.local.d.ts']) {
      expect(isSecretEnvPath(p), p).toBe(true);
    }
    for (const p of ['.env.d.ts', '.env.example', '.env.example.json', '.env-sample', 'app.template.env', 'example.env', 'example.env.json', 'prod.env.example.json', '.npmrc.example']) {
      expect(isSecretEnvPath(p), p).toBe(false);
    }
  });
  it('treats direnv files, *.env files and credential rc files as secret', () => {
    for (const p of ['.envrc', 'cfg/.envrc', '.envrc~', 'prod.env', 'cfg/Secrets.ENV', 'docker.env~', '.npmrc', '.netrc', '.pypirc', 'cfg/.npmrc']) {
      expect(isSecretEnvPath(p), p).toBe(true);
      expect(langOf(p), p).toBe('secret');
    }
    for (const p of ['prod.env.example', 'docker.env.sample', '.envrc.template', 'env', 'src/env.ts', 'my.envelope']) {
      expect(isSecretEnvPath(p), p).toBe(false);
    }
  });
  it('maps grammars', () => {
    expect(GRAMMAR.csharp).toBe('c_sharp');
    expect(GRAMMAR.markdown).toBeUndefined();
  });
});

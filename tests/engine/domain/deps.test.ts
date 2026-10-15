import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from '../../../src/engine/domain/index.js';
import { deps, parseVersionCatalog, resolveCatalogDeps } from '../../../src/engine/domain/deps.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/deps/', import.meta.url));
const read = (name: string): string => fs.readFileSync(path.join(DIR, name), 'utf8');
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [deps]).deps;

const GOLDEN: Record<string, { name: string; version: string; eco: string; dev?: true; line: number }[]> = {
  'package.json': [
    { name: 'react', version: '^18.3.1', eco: 'npm', line: 8 },
    { name: 'zod', version: '3.23.8', eco: 'npm', line: 9 },
    { name: 'vitest', version: '^2.1.0', eco: 'npm', dev: true, line: 12 },
  ],
  'requirements.txt': [
    { name: 'fastapi', version: '0.110.0', eco: 'pypi', line: 2 },
    { name: 'uvicorn', version: '>=0.29', eco: 'pypi', line: 3 },
    { name: 'requests', version: '', eco: 'pypi', line: 4 },
    { name: 'SQLAlchemy', version: '>=2.0,<3', eco: 'pypi', line: 7 },
    { name: 'urllib3', version: '2.2.1', eco: 'pypi', line: 8 },
    { name: 'idna', version: '3.7', eco: 'pypi', line: 11 },
    { name: 'certifi', version: '>=2', eco: 'pypi', line: 12 },
    { name: 'numpy', version: '1.26', eco: 'pypi', line: 13 },
    { name: 'six', version: '1.16', eco: 'pypi', line: 14 },
  ],
  'pyproject.toml': [
    { name: 'fastapi', version: '>=0.110', eco: 'pypi', line: 7 },
    { name: 'uvicorn', version: '0.29.0', eco: 'pypi', line: 8 },
    { name: 'pydantic', version: '2.7.0', eco: 'pypi', line: 9 },
    { name: 'httpx', version: '', eco: 'pypi', line: 10 },
    { name: 'sqlalchemy', version: '^2.0', eco: 'pypi', line: 15 },
    { name: 'celery', version: '^5.3', eco: 'pypi', line: 16 },
    { name: 'pytest', version: '^8.0', eco: 'pypi', dev: true, line: 19 },
    { name: 'coverage', version: '>=7', eco: 'pypi', dev: true, line: 22 },
    { name: 'psycopg', version: '>=3.1', eco: 'pypi', line: 24 },
  ],
  'go.mod': [
    { name: 'github.com/gin-gonic/gin', version: 'v1.10.0', eco: 'go', line: 5 },
    { name: 'github.com/google/uuid', version: 'v1.6.0', eco: 'go', line: 8 },
    { name: 'golang.org/x/text', version: 'v0.14.0', eco: 'go', line: 9 },
  ],
  'Cargo.toml': [
    { name: 'serde', version: '1.0', eco: 'cargo', line: 6 },
    { name: 'tokio', version: '1.38', eco: 'cargo', line: 7 },
    { name: 'local', version: '', eco: 'cargo', line: 8 },
    { name: 'proptest', version: '1.4', eco: 'cargo', dev: true, line: 11 },
    { name: 'cc', version: '1.0', eco: 'cargo', line: 14 },
    { name: 'reqwest', version: '0.12', eco: 'cargo', line: 16 },
    { name: 'nix', version: '0.29', eco: 'cargo', line: 21 },
    { name: 'winapi', version: '0.3', eco: 'cargo', dev: true, line: 23 },
  ],
  Gemfile: [
    { name: 'rails', version: '~> 7.1', eco: 'gem', line: 3 },
    { name: 'pg', version: '', eco: 'gem', line: 4 },
    { name: 'puma', version: '>= 5.0, < 7', eco: 'gem', line: 5 },
  ],
  'composer.json': [
    { name: 'laravel/framework', version: '^11.0', eco: 'composer', line: 5 },
    { name: 'phpunit/phpunit', version: '^11.0', eco: 'composer', dev: true, line: 8 },
  ],
  'build.gradle': [
    { name: 'org.springframework.boot:spring-boot-starter-web', version: '3.3.0', eco: 'maven', line: 6 },
    { name: 'com.google.guava:guava', version: '33.2.0-jre', eco: 'maven', line: 7 },
    { name: 'org.postgresql:postgresql', version: '42.7.3', eco: 'maven', line: 8 },
    { name: 'org.junit.jupiter:junit-jupiter', version: '', eco: 'maven', dev: true, line: 9 },
    { name: 'org.projectlombok:lombok', version: '1.18.32', eco: 'maven', line: 10 },
    { name: 'org.projectlombok:lombok', version: '1.18.32', eco: 'maven', line: 11 },
    { name: 'androidx.test:runner', version: '1.5.2', eco: 'maven', dev: true, line: 15 },
  ],
  // Catalog accessors are kept as written; the domain index resolves them against gradle/libs.versions.toml.
  'build.gradle.kts': [
    { name: 'libs.androidx.core.ktx', version: '', eco: 'maven', line: 7 },
    { name: 'libs.androidx.room.runtime', version: '', eco: 'maven', line: 8 },
    { name: 'libs.androidx.room.compiler', version: '', eco: 'maven', line: 9 },
    { name: 'com.google.dagger:hilt-compiler', version: '2.51', eco: 'maven', line: 10 },
    { name: 'libs.junit', version: '', eco: 'maven', dev: true, line: 13 },
    { name: 'androidx.test.ext:junit', version: '1.1.5', eco: 'maven', dev: true, line: 14 },
    { name: 'libs.bundles.ktor', version: '', eco: 'maven', line: 15 },
  ],
  'pubspec.yaml': [
    { name: 'flutter', version: 'sdk', eco: 'pub', line: 6 },
    { name: 'http', version: '^1.2.0', eco: 'pub', line: 8 },
    { name: 'provider', version: '6.1.2', eco: 'pub', line: 9 },
    { name: 'flutter_test', version: 'sdk', eco: 'pub', dev: true, line: 12 },
    { name: 'lints', version: '^4.0.0', eco: 'pub', dev: true, line: 14 },
  ],
  Podfile: [
    { name: 'Alamofire', version: '~> 5.8', eco: 'cocoapods', line: 4 },
    { name: 'SnapKit', version: '', eco: 'cocoapods', line: 5 },
  ],
};

describe('deps analyzer', () => {
  for (const [file, golden] of Object.entries(GOLDEN)) {
    it(`reads ${file}`, () => {
      expect(run(file, read(file))?.deps).toEqual(golden);
    });
  }

  it('ends a pyproject dependencies array only on a bracket outside strings', () => {
    const single = '[project]\ndependencies = ["uvicorn[standard]>=0.29", "rich",\n  "typer[all]",\n]\n\n[tool.other]\nx = ["not-a-dep"]\n';
    expect(run('pyproject.toml', single)?.deps).toEqual([
      { name: 'uvicorn', version: '>=0.29', eco: 'pypi', line: 2 },
      { name: 'rich', version: '', eco: 'pypi', line: 2 },
      { name: 'typer', version: '', eco: 'pypi', line: 3 },
    ]);
    expect(run('pyproject.toml', '[project]\ndependencies = ["a[x]", "b"]\nother = ["c"]\n')?.deps?.map(d => d.name)).toEqual(['a', 'b']);
  });

  it('reads pyproject strings whose markers hold the other quote type', () => {
    const dq = '[project]\ndependencies = [\n  "a[x]; python_version < \'3.9\'",\n  "b>=1",\n  "c",\n]\n';
    expect(run('pyproject.toml', dq)?.deps).toEqual([
      { name: 'a', version: '', eco: 'pypi', line: 3 },
      { name: 'b', version: '>=1', eco: 'pypi', line: 4 },
      { name: 'c', version: '', eco: 'pypi', line: 5 },
    ]);
    const sq = "[project]\ndependencies = ['tomli>=2; python_version < \"3.11\"', 'rich[jupyter]==13.7.1',\n  'typer',\n]\n[tool.x]\ny = ['z']\n";
    expect(run('pyproject.toml', sq)?.deps).toEqual([
      { name: 'tomli', version: '>=2', eco: 'pypi', line: 2 },
      { name: 'rich', version: '13.7.1', eco: 'pypi', line: 2 },
      { name: 'typer', version: '', eco: 'pypi', line: 3 },
    ]);
  });

  it('reads only dependency configurations in Gradle, not other words before an "a:b" string', () => {
    const src = "dependencies {\n  println \"stage:deploy\"\n  mainClassName 'com.app:Main'\n  archivesBaseName \"lib:core\"\n  debugImplementation 'com.squareup:leak:2.0'\n  kaptTest(\"com.google:dagger:2.5\")\n  coreLibraryDesugaring 'com.android:desugar:2.0'\n}\n";
    expect(run('build.gradle', src)?.deps.map(d => d.name)).toEqual(['com.squareup:leak', 'com.google:dagger', 'com.android:desugar']);
    const plugins = "dependencies {\n  shadow 'com.foo:bar:1.0'\n  antlr \"org.antlr:antlr4:4.13.1\"\n  errorprone(\"com.google.errorprone:error_prone_core:2.0\")\n  jmh 'org.openjdk.jmh:jmh-core:1.37'\n  provided 'javax:servlet-api:3.1'\n}\n";
    expect(run('build.gradle', plugins)?.deps.map(d => d.name)).toEqual(['com.foo:bar', 'org.antlr:antlr4', 'com.google.errorprone:error_prone_core', 'org.openjdk.jmh:jmh-core', 'javax:servlet-api']);
  });

  it('resolves Gradle catalog accessors against libs.versions.toml, bundles included', () => {
    const catalog = parseVersionCatalog(read('gradle/libs.versions.toml'));
    expect(catalog.get('androidx.room.runtime')).toEqual([{ name: 'androidx.room:room-runtime', version: '2.6.1' }]);
    expect(catalog.has('android.application')).toBe(false);
    expect(resolveCatalogDeps(run('build.gradle.kts', read('build.gradle.kts'))!.deps, catalog)).toEqual([
      { name: 'androidx.core:core-ktx', version: '1.13.1', eco: 'maven', line: 7 },
      { name: 'androidx.room:room-runtime', version: '2.6.1', eco: 'maven', line: 8 },
      { name: 'androidx.room:room-compiler', version: '2.6.1', eco: 'maven', line: 9 },
      { name: 'com.google.dagger:hilt-compiler', version: '2.51', eco: 'maven', line: 10 },
      { name: 'junit:junit', version: '4.13.2', eco: 'maven', dev: true, line: 13 },
      { name: 'androidx.test.ext:junit', version: '1.1.5', eco: 'maven', dev: true, line: 14 },
      { name: 'io.ktor:ktor-client-core', version: '2.3.12', eco: 'maven', line: 15 },
      { name: 'io.ktor:ktor-client-cio', version: '2.3.12', eco: 'maven', line: 15 },
    ]);
    const groovy = "dependencies {\n  implementation libs.androidx.core.ktx\n  kaptTest libs.junit\n  implementation libs.missing\n}\n";
    expect(resolveCatalogDeps(run('build.gradle', groovy)!.deps, catalog).map(d => `${d.name}${d.dev ? ' dev' : ''}`))
      .toEqual(['androidx.core:core-ktx', 'junit:junit dev', 'libs.missing']);
    expect(resolveCatalogDeps(run('build.gradle', groovy)!.deps, null).map(d => d.name)).toEqual(['libs.androidx.core.ktx', 'libs.junit', 'libs.missing']);
  });

  it('reads package.json scripts', () => {
    expect(run('package.json', read('package.json'))?.scripts).toEqual({ dev: 'vite', build: 'tsc && vite build' });
  });

  it('reads build.gradle.kts and nested manifests by basename', () => {
    const kts = 'dependencies {\n    implementation("io.ktor:ktor-server-core:2.3.11")\n    testImplementation(kotlin("test"))\n}\n';
    expect(run('app/build.gradle.kts', kts)?.deps).toEqual([{ name: 'io.ktor:ktor-server-core', version: '2.3.11', eco: 'maven', line: 2 }]);
    expect(run('services/api/requirements-dev.txt', 'pytest==8.2.0\n')?.deps).toEqual([{ name: 'pytest', version: '8.2.0', eco: 'pypi', line: 1 }]);
  });

  it('applies only to manifest basenames', () => {
    expect(deps.applies('src/package.ts', 'typescript')).toBe(false);
    expect(deps.applies('requirements.md', 'markdown')).toBe(false);
    expect(deps.applies('apps/web/package.json', 'json')).toBe(true);
    expect(deps.applies('Gemfile.lock', 'other')).toBe(false);
  });

  it('yields no deps for invalid JSON, empty files and comment-only files', () => {
    expect(run('package.json', '{"dependencies": {"zod": ')?.deps ?? []).toEqual([]);
    expect(run('composer.json', 'not json')?.deps ?? []).toEqual([]);
    for (const f of Object.keys(GOLDEN)) expect(run(f, '')?.deps ?? []).toEqual([]);
    expect(run('requirements.txt', '# only\n   # comments\n')?.deps ?? []).toEqual([]);
    expect(run('Gemfile', "# gem 'rails'\n")?.deps ?? []).toEqual([]);
    expect(run('go.mod', '// require x v1\n')?.deps ?? []).toEqual([]);
    expect(run('Cargo.toml', '# [dependencies]\n# serde = "1"\n')?.deps ?? []).toEqual([]);
    expect(run('Podfile', "# pod 'X'\n")?.deps ?? []).toEqual([]);
    expect(run('build.gradle', "// implementation 'a:b:1'\n")?.deps ?? []).toEqual([]);
  });

  it('reads Cargo workspace-inherited deps by crate name with no version', () => {
    expect(run('Cargo.toml', '[dependencies]\nserde.workspace = true\ntokio = { workspace = true, features = ["full"] }\n\n[dev-dependencies]\nproptest.workspace = true\n')?.deps).toEqual([
      { name: 'serde', version: '', eco: 'cargo', line: 2 },
      { name: 'tokio', version: '', eco: 'cargo', line: 3 },
      { name: 'proptest', version: '', eco: 'cargo', dev: true, line: 6 },
    ]);
  });

  it('ignores non-string values in package.json', () => {
    expect(run('package.json', '{"dependencies":{"a":1,"b":"2"},"scripts":{"x":3}}')).toEqual({
      deps: [{ name: 'b', version: '2', eco: 'npm', line: 1 }],
      scripts: {},
    });
  });
});

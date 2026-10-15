import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { schemaPy } from '../../../src/engine/domain/schema-py.js';
import { langOf } from '../../../src/engine/languages.js';

/** Wall-clock budgets are for a developer machine; CI sets a larger factor on slower macOS and Windows runners. */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const DIR = fileURLToPath(new URL('../../fixtures/domain/schema/', import.meta.url));
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [schemaPy]).entities;
const names = (rel: string, text: string): string[] => run(rel, text).map(e => e.name);

describe('schema-py analyzer', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const orm of ['sqlalchemy', 'sqlalchemy-mapped', 'sqlmodel', 'django']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, orm, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${orm}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, orm, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to Python', () => {
    expect(ANALYZERS).toContain(schemaPy);
    expect(schemaPy.applies('app/models.py', 'python')).toBe(true);
    expect(schemaPy.applies('a/B.kt', 'kotlin')).toBe(false);
    expect(schemaPy.applies('src/a.ts', 'typescript')).toBe(false);
  });
  it('survives an unterminated Python class body', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const src = "class A(Base):\n    __tablename__ = 'a'\n    id = Column(Integer, primary_key=True\n    name = Column(String)\n";
    expect(run('m.py', src)).toEqual([
      { name: 'A', table: 'a', orm: 'sqlalchemy', file: 'm.py', line: 1, fields: [{ name: 'name', type: 'String', line: 4 }] },
    ]);
    expect(names('m.py', "class B(Base:\n    __tablename__ = 'b'\n")).toEqual([]);
    expect(names('m.py', "class C(Base):\n    __tablename__ = 'c'")).toEqual(['C']);
    expect(run('m.py', 'class')).toEqual([]);
    expect(run('models.py', 'class D(models.Model):\n    x = models.CharField(\n')).toEqual([
      { name: 'D', table: 'd', orm: 'django', file: 'models.py', line: 1, fields: [{ name: 'id', type: 'AutoField', line: 1, pk: true, required: true }] },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ends a Python class body at the first line indented no deeper than the class', () => {
    const src = [
      'class A(Base):',
      "    __tablename__ = 'a'",
      '    def f(self):',
      '        x = Column(Integer)',
      '    y = Column(',
      'Integer)',
      '    if TYPE_CHECKING:',
      '        z = Column(Integer)',
      'w = Column(Integer)',
      '    v = Column(Integer)',
    ].join('\n');
    expect(run('m.py', src)[0].fields.map(f => f.name)).toEqual(['y']);
  });

  it('keeps one entity per lowercased name in a file, the later one winning', () => {
    const py = "class A(Base):\n    __tablename__ = 'a1'\n\nclass a(Base):\n    __tablename__ = 'a2'\n\nclass B(Base):\n    __tablename__ = 'b'\n";
    expect(run('m.py', py).map(e => [e.name, e.table])).toEqual([['a', 'a2'], ['B', 'b']]);
  });

  it('needs __tablename__ or a declarative base with columns for SQLAlchemy, and table=True for SQLModel', () => {
    expect(names('m.py', 'class A(Base):\n    pass\n')).toEqual([]);
    expect(names('m.py', 'class A(Thing):\n    x = Column(Integer)\n')).toEqual([]);
    expect(names('m.py', 'class A(Base):\n    __abstract__ = True\n    x = Column(Integer)\n')).toEqual([]);
    expect(names('m.py', 'Model = declarative_base()\nclass A(Model):\n    x = Column(Integer)\n')).toEqual(['A']);
    expect(names('m.py', 'class A(SQLModel):\n    x: int\n')).toEqual([]);
    expect(names('m.py', 'class A(SQLModel, table=True):\n    x: int\n')).toEqual(['A']);
  });

  it('reads Django models only in models files, skipping abstract and non-model classes', () => {
    const src = 'from django.db import models\n\nclass A(models.Model):\n    x = models.IntegerField()\n';
    expect(names('app/views.py', src)).toEqual([]);
    expect(run('shop/models.py', src)[0].table).toEqual('shop_a');
    expect(run('shop/models/a.py', src)[0].table).toEqual('shop_a');
    expect(names('models.py', 'class A(Model):\n    x = CharField()\n')).toEqual([]);
    expect(names('models.py', 'class A(models.Model):\n    class Meta:\n        abstract = True\n')).toEqual([]);
  });

  it('ignores schema code inside strings and comments', () => {
    expect(run('m.py', '"""\nclass A(Base):\n    __tablename__ = \'a\'\n"""\n# class B(Base):\n#     __tablename__ = \'b\'\n')).toEqual([]);
  });

  it('keeps the later of two classes with the same exact name, with its own fields and bases', () => {
    const src = "class A(Base):\n    __tablename__ = 'a1'\n    old = Column(Integer)\n\nclass A(Base):\n    __tablename__ = 'a2'\n    new = Column(Integer)\n";
    expect(run('m.py', src).map(e => [e.table, e.fields.map(f => f.name)])).toEqual([['a2', ['new']]]);
    const bases = "class M:\n    a = Column(Integer)\n\nclass X(M, Base):\n    __tablename__ = 'x'\n\nclass M:\n    b = Column(Integer)\n\nclass Y(M, Base):\n    __tablename__ = 'y'\n";
    expect(run('m.py', bases).map(e => [e.name, e.fields.map(f => f.name)])).toEqual([['X', ['a']], ['Y', ['b']]]);
  });

  it('reads a classic relationship as many when the in-file target has a foreign key to this table', () => {
    const src = [
      'class User(Base):', "    __tablename__ = 'users'", '    id = Column(Integer, primary_key=True)', "    orders = relationship('Order')", "    profile = relationship('Profile')",
      'class Order(Base):', "    __tablename__ = 'orders'", "    user_id = Column(Integer, ForeignKey('users.id'))", "    user = relationship('User')",
      'class Profile(Base):', "    __tablename__ = 'profiles'", '    id = Column(Integer, primary_key=True)',
    ].join('\n');
    const rel = (e: string, f: string) => run('m.py', src).find(x => x.name === e)!.fields.find(x => x.name === f)!.relation;
    expect(rel('User', 'orders')).toEqual({ model: 'Order', many: true });
    expect(rel('User', 'profile')).toEqual({ model: 'Profile', many: false });
    expect(rel('Order', 'user')).toEqual({ model: 'User', many: false });
  });

  it('merges single-table inheritance subclasses into the nearest entity ancestor', () => {
    const src = "class Animal(Base):\n    __tablename__ = 'animals'\n    id = Column(Integer, primary_key=True)\n\nclass Dog(Animal):\n    bark = Column(String)\n\nclass Puppy(Dog):\n    age = Column(Integer)\n\nclass Cat(Animal):\n    __tablename__ = 'cats'\n    id = Column(Integer, ForeignKey('animals.id'), primary_key=True)\n";
    expect(run('m.py', src).map(e => [e.name, e.table, e.fields.map(f => `${f.name}:${f.line}`)])).toEqual([
      ['Animal', 'animals', ['id:3', 'bark:6', 'age:9']],
      ['Cat', 'cats', ['id:13']],
    ]);
  });

  it('detects a multi-line Django Model import', () => {
    expect(names('shop/models.py', 'from django.db.models import (\n    CharField,\n    Model,\n)\n\nclass A(Model):\n    x = CharField()\n')).toEqual(['A']);
  });

  it('reads relationship(remote_side=...) on a self-reference as many-to-one', () => {
    const src = "class Node(Base):\n    __tablename__ = 'nodes'\n    id = Column(Integer, primary_key=True)\n    parent_id = Column(Integer, ForeignKey('nodes.id'))\n    parent = relationship('Node', remote_side=[id])\n    children = relationship('Node')\n";
    const fields = run('m.py', src)[0].fields;
    expect(fields.find(f => f.name === 'parent')!.relation).toEqual({ model: 'Node', many: false });
    expect(fields.find(f => f.name === 'children')!.relation).toEqual({ model: 'Node', many: true });
  });

  it('keeps a subclass with its own primary key as a joined-inheritance entity', () => {
    const src = "class Animal(Base):\n    __tablename__ = 'animals'\n    id = Column(Integer, primary_key=True)\n\nclass Dog(Animal):\n    id = Column(Integer, ForeignKey('animals.id'), primary_key=True)\n    bark = Column(String)\n";
    expect(run('m.py', src).map(e => [e.name, e.table, e.fields.map(f => f.name)])).toEqual([
      ['Animal', 'animals', ['id']],
      ['Dog', 'dog', ['id', 'bark']],
    ]);
  });

  it('stays linear on ~1 MB of hostile input', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cases: [string, string][] = [
      ['m.py', '__tablename__ = 1\n' + 'class A(Base):\n'.repeat(70000)],
      ['m.py', "class A(Base):\n    __tablename__ = 'a'\n" + '    x = Column(Integer, ForeignKey("a.id"))\n'.repeat(25000)],
      ['m.py', '('.repeat(1_000_000)],
      ['m.py', 'class A('.repeat(120000)],
      ['m.py', 'class A(Base):\n    x = Column(' + 'f(a=1, '.repeat(140000)],
      ['m.py', Array.from({ length: 40000 }, (_, i) => `class A${i}(A${i + 1}):\n    x${i} = Column(Integer)\n`).join('')],
      ['m.py', 'class M:\n' + '    x = Column(Integer)\n'.repeat(20000) + "class A(M, Base):\n    __tablename__ = 'a'\n".repeat(10000)],
      ['m.py', '__tablename__ = 1\n' + Array.from({ length: 30000 }, (_, i) => `class C${i}(Base):\n` + ' '.repeat(i % 50 + 1)).join('\n')],
      ['models.py', 'class A(models.Model):\n    f = models.ForeignKey("A")\n'.repeat(18000)],
      ['models.py', 'class A(models.Model):\n    class Meta:\n'.repeat(25000)],
      ['m.py', 'class A(Base):\n    x: Mapped[' + 'Optional['.repeat(100000)],
      ['models.py', 'class A(models.Model):\n    pass\n' + 'from django.db.models import (\n'.repeat(32000)],
      ['models.py', 'class A(models.Model):\n    pass\n' + 'from django.db.models import (' + ' x,'.repeat(300000)],
      ['m.py', "class A0(Base):\n    __tablename__ = 'a'\n" + Array.from({ length: 30000 }, (_, i) => `class A${i + 1}(A${i}):\n    x${i} = Column(Integer)\n`).join('')],
      ['m.py', "class B(Base):\n    __tablename__ = 'b'\n" + "    r = relationship('B')\n".repeat(40000)],
    ];
    for (const [rel, t] of cases) {
      const start = performance.now();
      run(rel, t);
      // A backtracking regex takes seconds to minutes here; slower CI runners scale the budget (LIVEMAP_TIME_SCALE).
      expect(performance.now() - start, `${rel} ${t.slice(0, 24)}`).toBeLessThan(1000 * TIME_SCALE);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

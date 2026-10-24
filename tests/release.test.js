import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicFiles } from '../scripts/release-files.mjs';

async function fixture(t) {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, 'douyin-public-release-'));
  t.after(async () => {
    const target = path.resolve(root);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('douyin-public-release-')) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  });
  const put = async (name, text = 'fixture') => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  return { root, put };
}

test('public export preserves docs and hidden templates but excludes compiled Python cache', async t => {
  const { root, put } = await fixture(t);
  for (const name of ['docs/images/demo.svg', '.github/workflows/ci.yml', '.env.example', 'runner/main.py', 'runner/__pycache__/main.pyc']) await put(name);
  await put('.env', 'private-fixture-do-not-export');
  assert.deepEqual(await publicFiles(root, ['docs', '.github', '.env.example', 'runner']), [
    '.env.example', '.github/workflows/ci.yml', 'docs/images/demo.svg', 'runner/main.py'
  ]);
});

test('unexpected secret and runtime files inside a selected directory fail closed', async t => {
  const { root, put } = await fixture(t);
  for (const [index, name] of ['.env', '.env.local', 'SMTP.key', 'alerts.sqlite3', 'debug.log', 'HANDOFF_PERSONAL.md'].entries()) {
    const folder = 'case-' + index;
    await put(folder + '/' + name);
    await assert.rejects(publicFiles(root, [folder]), /Private or runtime file/);
  }
});

test('export rejects paths outside the project and explicit private directories', async t => {
  const { root, put } = await fixture(t);
  await put('data/alerts.txt');
  await assert.rejects(publicFiles(root, ['../outside']), /leaves project/);
  await assert.rejects(publicFiles(root, ['data']), /Private or runtime file/);
});

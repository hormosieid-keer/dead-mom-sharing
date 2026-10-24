import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { publicFiles } from './release-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const files = await publicFiles(root);
const docs = files.filter(file => file.endsWith('.md'));
const cache = new Map();
const contents = async file => {
  if (!cache.has(file)) cache.set(file, await readFile(path.join(root, file), 'utf8'));
  return cache.get(file);
};
let links = 0, images = 0;
for (const file of docs) {
  const text = await contents(file);
  assert.ok(!/(?:[A-Za-z]:[\\/])(?:Users[\\/]|AI工作区)/u.test(text), 'Personal machine path in ' + file);
  for (const match of text.matchAll(/(!?)\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/gu)) {
    const [, image, href] = match;
    if (/^[a-z][a-z\d+.-]*:/iu.test(href)) { assert.ok(!href.startsWith('file:'), 'Local file URL in ' + file); continue; }
    const [raw, fragment] = href.split('#');
    const target = raw ? path.resolve(root, path.dirname(file), decodeURIComponent(raw)) : path.join(root, file);
    assert.ok(target.startsWith(root + path.sep), 'Link escapes repository: ' + file);
    assert.ok((await stat(target)).isFile(), `Broken link in ${file}: ${href}`);
    const relative = path.relative(root, target).split(path.sep).join('/');
    assert.ok(files.includes(relative), `Link not included in public export: ${file} -> ${href}`);
    if (fragment && target.endsWith('.md')) {
      const linked = await contents(relative), id = decodeURIComponent(fragment);
      const ids = [...linked.matchAll(/<a\s+id="([^"]+)"/gu)].map(item => item[1]);
      const headings = [...linked.matchAll(/^#{1,6}\s+(.+)$/gmu)].map(item => item[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /gu, '-'));
      assert.ok([...ids, ...headings].includes(id), `Missing anchor in ${file}: ${href}`);
    }
    links++;
    if (image) images++;
  }
}
const manifest = JSON.parse(await contents('extension/manifest.json'));
for (const file of ['extension/background.js', 'extension/options.js']) assert.ok((await contents(file)).includes(manifest.version_name), 'Build mismatch: ' + file);
assert.ok((await contents('README.md')).includes(manifest.version_name), 'README build mismatch');
assert.ok(images >= 7, 'README needs the installation diagram and six UI screenshots');
console.log(`PASS: ${docs.length} public Markdown files, ${links} local links, ${images} images, public-file boundaries and build labels checked.`);

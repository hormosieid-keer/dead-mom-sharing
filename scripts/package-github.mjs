import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { publicFiles, writeArchive, releaseVersion } from './release-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = await releaseVersion(root);
const files = await publicFiles(root);
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '');
// A new folder each run avoids overwriting a user-edited previous export.
const folder = path.join(dist, 'github-ready', `dead-mom-sharing-${version}-${stamp}`);
await mkdir(folder, { recursive: true });
for (const file of files) {
  const target = path.join(folder, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
}
const output = path.join(dist, `dead-mom-sharing-github-${version}.zip`);
const report = writeArchive(root, output, files, 'dead-mom-sharing/');
const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(path.join(dist, 'GITHUB-SHA256SUMS.txt'), `${sha256}  ${path.basename(output)}\n`);
await writeFile(path.join(dist, 'github-export.json'), JSON.stringify({ folder, archive: output, entries: files.length, sha256 }, null, 2) + '\n');
console.log(JSON.stringify({ folder, ...report, sha256 }, null, 2));

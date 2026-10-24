import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { publicFiles, writeArchive, releaseVersion } from './release-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = await releaseVersion(root);
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
await mkdir(path.join(root, 'extension', 'licenses'), { recursive: true });
await copyFile(path.join(root, 'LICENSE'), path.join(root, 'extension', 'LICENSE.txt'));
const outputs = [];
for (const [name, selected] of [
  [`dead-mom-sharing-${version}.zip`, await publicFiles(root)],
  [`dead-mom-sharing-extension-${version}.zip`, await publicFiles(root, ['extension'])]
]) {
  const target = path.join(dist, name);
  const report = writeArchive(root, target, selected);
  const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  outputs.push({ ...report, sha256 });
  console.log(`${sha256}  ${name}`);
}
await writeFile(path.join(dist, 'SHA256SUMS.txt'), outputs.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
await writeFile(path.join(dist, 'package-verification.json'), JSON.stringify(outputs.map(item => ({ name: item.file, bytes: item.bytes, entries: item.entries })), null, 2) + '\n');

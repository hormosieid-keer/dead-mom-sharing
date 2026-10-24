import { lstat, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Explicit public surface. Personal handoffs, research, runtime databases,
// credentials, logs and test outputs are deliberately not source releases.
export const PUBLIC_ENTRIES = [
  'extension', 'runner', 'deploy', 'scripts', 'tests', 'docs', '.github',
  'README.md', 'TESTING.md', 'THIRD_PARTY.md', 'AGENTS.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'LICENSE', '.env.example', '.gitignore', '.dockerignore',
  'requirements-runner.txt', 'start-mail.ps1', 'start-server.ps1',
  'package.json', 'package-lock.json'
];

export async function publicFiles(root, entries = PUBLIC_ENTRIES) {
  const files = [];
  async function walk(relative) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Export path leaves project');
    const parts = relative.split('/'), name = parts.at(-1);
    if (name === '__pycache__' || /\.pyc$/u.test(name)) return;
    if (parts.some(part => ['.git', 'node_modules', 'data', 'research', 'test-results', 'dist', '.venv'].includes(part)) ||
      /^HANDOFF/iu.test(name) || (/^\.env(?:\.|$)/u.test(name) && relative !== '.env.example') ||
      /\.(?:log|sqlite3?|db|pem|key|p12)(?:-|$)/iu.test(name)) throw new Error('Private or runtime file in public selection: ' + relative);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not exported: ' + relative);
    if (info.isDirectory()) {
      for (const child of (await readdir(target)).sort()) await walk(relative + '/' + child);
    } else if (info.isFile()) files.push(relative);
    else throw new Error('Unsupported public file: ' + relative);
  }
  for (const entry of entries) await walk(entry);
  return files.sort();
}

export function writeArchive(root, output, files, prefix = '') {
  const script = String.raw`import json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]).resolve()
output=pathlib.Path(sys.argv[2]).resolve()
if output.parent != root/'dist': raise ValueError('Archive must be in project dist')
files=json.loads(sys.argv[3]); prefix=sys.argv[4]
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
    for item in files:
        file=root/item
        if file.is_symlink() or not file.is_file(): raise ValueError('Invalid public file: '+item)
        archive.write(file,prefix+item)
print(json.dumps({'file':output.name,'entries':len(files),'bytes':output.stat().st_size}))`;
  return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', script, root, output, JSON.stringify(files), prefix], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  }));
}

export async function releaseVersion(root) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Unsupported release version');
  return version;
}

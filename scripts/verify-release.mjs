import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { publicFiles, releaseVersion } from './release-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = await releaseVersion(root);
const files = await publicFiles(root);
const script = String.raw`import hashlib,json,pathlib,sys,zipfile,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]); version=sys.argv[2]; public=json.loads(sys.argv[3])
checks=[('dead-mom-sharing-'+version+'.zip','',public),('dead-mom-sharing-extension-'+version+'.zip','',[p for p in public if p.startswith('extension/')]),('dead-mom-sharing-github-'+version+'.zip','dead-mom-sharing/',public)]
secret_values=[]
env=root/'.env'
if env.is_file():
    for line in env.read_text(encoding='utf-8-sig').splitlines():
        key,sep,value=line.partition('='); value=value.strip().strip('\"').strip("'")
        if sep and key.strip() in ('BOT_BRIDGE_TOKEN','SMTP_PASSWORD','SMTP_USER','SMTP_FROM','ALERT_EMAIL_TO') and len(value)>=8: secret_values.append(value.encode('utf-8'))
for name,prefix,expected in checks:
    target=root/'dist'/name
    with zipfile.ZipFile(target) as archive:
        assert len(archive.namelist())==len(set(archive.namelist())), 'Duplicate archive entry'
        assert set(archive.namelist())=={prefix+p for p in expected}, 'Archive does not match public allowlist: '+name
        for p in expected:
            data=archive.read(prefix+p)
            assert data==(root/p).read_bytes(), 'Source mismatch: '+p
            assert not any(value in data for value in secret_values), 'Private configuration value found; content withheld: '+p
    sums=(root/'dist'/('GITHUB-SHA256SUMS.txt' if prefix else 'SHA256SUMS.txt')).read_text(encoding='utf-8').splitlines()
    assert hashlib.sha256(target.read_bytes()).hexdigest()+'  '+name in sums, 'Checksum mismatch'
    print('PASS:',name,'exact files, source bytes, checksums and private-value scan')
export=json.loads((root/'dist/github-export.json').read_text(encoding='utf-8'))
folder=pathlib.Path(export['folder']).resolve(); parent=(root/'dist/github-ready').resolve()
assert folder.parent==parent, 'Export outside managed directory'
actual={p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()}
assert actual==set(public), 'Clean GitHub folder has unexpected files'
for p in public: assert (folder/p).read_bytes()==(root/p).read_bytes(), 'Export source mismatch: '+p
ET.parse(root/'docs/images/install-flow.svg')
print('PASS: clean GitHub folder and SVG; no runtime files or personal handoffs in public artifacts')`;
try {
  process.stdout.write(execFileSync(process.env.PYTHON || 'python', ['-c', script, root, version, JSON.stringify(files)], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  process.stderr.write('Release verification failed. See the diagnostic above; no configuration values are printed.\n');
  process.exitCode = 1;
}

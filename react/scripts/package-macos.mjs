import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Run npm run dist with native ARM64 Node.js on an Apple Silicon Mac.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = path.join(root, '.packaging');
const runtime = path.join(staging, 'python');
// Astral python-build-standalone release for a relocatable ARM64 CPython installation.
const release = '20261110';
const archiveName = `cpython-3.12.16+${release}-aarch64-apple-darwin-install_only_stripped.tar.gz`;
const archiveUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${encodeURIComponent(archiveName)}`;
const archiveHash = '2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd';
const archive = path.join(staging, archiveName);

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
}

function checkArchive(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex') === archiveHash;
}

mkdirSync(staging, { recursive: true });
const workDir = mkdtempSync(path.join(staging, 'python-build-'));
try {
  if (!existsSync(archive) || !checkArchive(archive)) {
    const download = path.join(workDir, archiveName);
    run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--retry', '2', '--output', download, archiveUrl]);
    if (!checkArchive(download)) throw new Error('Downloaded Python archive has the wrong SHA-256 checksum.');
    renameSync(download, archive);
  }

  run('/usr/bin/tar', ['-xzf', archive, '-C', workDir]);
  const extracted = path.join(workDir, 'python');
  const python = path.join(extracted, 'bin', 'python3');
  run(python, ['-IB', '-m', 'pip', '--isolated', 'install', '--no-cache-dir', '--no-compile',
    '--only-binary=:all:', '-r', path.join(root, '../server/requirements.txt')]);
  // Fetch the installed RapidOCR version's default models into its package directory before signing the app.
  run(python, ['-IB', '-c', 'from rapidocr.utils.download_models import download_models; download_models()']);

  rmSync(runtime, { recursive: true, force: true });
  renameSync(extracted, runtime);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

run('npm', ['run', 'build'], { ...process.env, WALLED_PYTHON: path.join(runtime, 'bin', 'python3') });
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), ['--mac', '--arm64', '--dir', '--publish', 'never']);

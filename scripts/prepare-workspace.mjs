// Run inside the existing DSH sandbox, never as a Host filesystem operation.
import { copyFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertWorkspacePath(root, target) {
  root = path.resolve(root);
  target = path.resolve(target);
  if (!contained(root, target)) throw new Error('Roblox preparation target is outside the workspace.');
  // The sandbox is authoritative; additionally reject symlinks/reparse points so
  // this utility never seeds an apparently-local path backed by an external one.
  let current = target;
  while (true) {
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink() || !contained(realpathSync(root), realpathSync(current))) {
        throw new Error('Roblox preparation refuses redirected workspace paths.');
      }
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Cannot validate workspace path.');
    current = parent;
  }
  return target;
}

export function prepareWorkspace({ workspace, cwd = workspace, sourceAppData, config } = {}) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('An absolute workspace is required.');
  const root = realpathSync(workspace);
  const directory = assertWorkspacePath(root, cwd);
  const configs = new Set();
  if (config) {
    configs.add(assertWorkspacePath(root, path.resolve(directory, config)));
  } else {
    let current = directory;
    while (true) {
      const candidate = path.join(current, 'selene.toml');
      if (existsSync(candidate)) configs.add(candidate);
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  const seeded = [];
  for (const filename of configs) {
    assertWorkspacePath(root, filename);
    const destination = assertWorkspacePath(root, path.join(path.dirname(filename), 'roblox.yml'));
    if (existsSync(destination)) continue; // User-owned standards always win.
    const source = sourceAppData && path.join(sourceAppData, 'selene', 'roblox.yml');
    if (!source || !existsSync(source)) continue; // Local generator is the explicit fallback.
    const info = statSync(source);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Unexpected Selene standard-library cache.');
    copyFileSync(source, destination, 1); // COPYFILE_EXCL: never race-overwrite a project standard.
    seeded.push(destination);
  }
  return { seeded };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [workspace, cwd, sourceAppData, config] = process.argv.slice(2);
    prepareWorkspace({ workspace, cwd, sourceAppData, config });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Roblox workspace preparation failed.');
    process.exitCode = 1;
  }
}

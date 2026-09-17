import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'Frozt-src/Website';
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed${capture ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout?.trim() ?? '';
}
function configuredIdentity(key) {
  const result = spawnSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

// npm_execpath invokes npm portably without a shell or Windows .cmd quoting.
if (!process.env.npm_execpath) throw new Error('Run this script through npm run publish:pages.');
const pages = JSON.parse(run('gh', ['api', `repos/${repository}/pages`], root, true));
if (pages.build_type !== 'legacy' || pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/' || pages.cname !== 'mnlith.dev') {
  throw new Error('Expected GitHub Pages to publish gh-pages / with custom domain mnlith.dev. No deployment performed.');
}
run(process.execPath, [process.env.npm_execpath, 'test']);
run(process.execPath, [process.env.npm_execpath, 'run', 'build']);
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html')) || !existsSync(join(dist, 'CNAME'))) throw new Error('Build output is incomplete.');
const deployRoot = join(root, '.deploy');
mkdirSync(deployRoot, { recursive: true });
const checkout = mkdtempSync(join(realpathSync(deployRoot), 'pages-'));
run('git', ['clone', '--depth', '1', '--branch', 'gh-pages', `https://github.com/${repository}.git`, checkout]);

// Removal is restricted to this freshly created checkout; never follow symlinks.
const checkedRoot = realpathSync(checkout);
const expectedParent = realpathSync(deployRoot);
if (dirname(checkedRoot) !== expectedParent || !lstatSync(join(checkedRoot, '.git')).isDirectory()) throw new Error('Unsafe deployment checkout.');
for (const entry of readdirSync(checkedRoot)) {
  if (entry === '.git') continue;
  const target = resolve(checkedRoot, entry);
  const within = relative(checkedRoot, target);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || dirname(target) !== checkedRoot) throw new Error('Unsafe cleanup target.');
  const stat = lstatSync(target);
  rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: false });
}
for (const entry of readdirSync(dist)) cpSync(join(dist, entry), join(checkout, entry), { recursive: true });
writeFileSync(join(checkout, '.nojekyll'), '');
let name = configuredIdentity('user.name');
let email = configuredIdentity('user.email');
if (!name || !email) {
  const user = JSON.parse(run('gh', ['api', 'user'], root, true));
  if (!user.login || !Number.isInteger(user.id)) throw new Error('Could not verify GitHub commit identity.');
  name ||= user.name || user.login;
  email ||= `${user.id}+${user.login}@users.noreply.github.com`;
}
run('git', ['config', 'user.name', name], checkout);
run('git', ['config', 'user.email', email], checkout);
run('git', ['add', '--all'], checkout);
if (run('git', ['status', '--porcelain'], checkout, true)) {
  const source = run('git', ['rev-parse', '--short', 'HEAD'], root, true);
  run('git', ['commit', '-m', `Publish Monolith built from ${source}`], checkout);
  // A concurrent deployment causes a normal non-fast-forward rejection; never force.
  run('git', ['push', 'origin', 'HEAD:gh-pages'], checkout);
} else {
  console.log('Built site matches gh-pages; requesting a rebuild without a new commit.');
}
const build = JSON.parse(run('gh', ['api', '--method', 'POST', `repos/${repository}/pages/builds`], root, true));
console.log(`GitHub Pages build requested (${build.status || 'queued'}). Verify https://mnlith.dev after the build completes.`);
console.log(`Deployment checkout retained for inspection: ${checkout}`);

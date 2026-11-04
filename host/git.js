import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fail, branch, subdirectory, text } from './security.js'
const exec = promisify(execFile)
export async function git(cwd, args, { push = false, raw = false, truncate = false, maxBuffer = 256 * 1024 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|NAMESPACE|SHALLOW_FILE|REPLACE_REF_BASE)/.test(key)) delete env[key]
  try { const { stdout } = await exec('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args], { cwd, env, shell: false, timeout: push ? 60000 : 10000, maxBuffer, encoding: 'utf8' }); return truncate ? { text: stdout, truncated: false } : raw ? stdout : stdout.trim() } catch (error) { if (truncate && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { text: String(error.stdout ?? '').slice(0, maxBuffer), truncated: true }; fail(push ? 'PUSH_UNKNOWN' : 'GIT_FAILED', push ? 'Push did not confirm success; verify the remote branch before retrying' : 'Local Git verification failed; check the repository and local target ref') }
}
export async function root(directory) { if (!path.isAbsolute(directory ?? '') || directory.length > 4096) fail('INVALID_PATH', 'An existing absolute checkout path is required'); const canonical = await realpath(directory).catch(() => fail('INVALID_PATH', 'Checkout path does not exist')); const top = await git(canonical, ['rev-parse', '--show-toplevel']); const resolved = await realpath(top); if (canonical !== resolved) fail('INVALID_PATH', 'Bind the repository root, not a subdirectory'); return resolved }
export function remoteTarget(value) {
  const v = text(value, 'remote URL', 2048)
  let host, pathname
  if (/^[A-Za-z0-9_.-]+@[^:]+:.+$/.test(v)) { const match = v.match(/^[A-Za-z0-9_.-]+@([^:]+):(.+)$/); host = match[1].toLowerCase(); pathname = match[2] }
  else { let u; try { u = new URL(v) } catch { fail('REMOTE_MISMATCH', 'Use an HTTPS or SSH GitLab remote') }; if (!['https:', 'ssh:'].includes(u.protocol) || u.password || (u.protocol === 'https:' && u.username) || u.search || u.hash) fail('REMOTE_MISMATCH', 'Remote credentials, queries and unsupported protocols are forbidden'); host = (u.protocol === 'https:' ? u.host : u.hostname).toLowerCase(); pathname = u.pathname }
  if (/%|\\|\s/.test(pathname)) fail('REMOTE_MISMATCH', 'Remote path must be unencoded and unambiguous')
  return { host, project: pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') }
}
export function verifyTarget(url, connection, project) {
  const target = remoteTarget(url), base = new URL(connection.baseUrl), https = url.startsWith('https:')
  const expectedHost = (https ? base.host : base.hostname).toLowerCase()
  const prefix = https ? base.pathname.replace(/^\/+|\/+$/g, '') : ''
  const expectedProject = [prefix, project.pathWithNamespace].filter(Boolean).join('/')
  if (target.host !== expectedHost || target.project !== expectedProject) fail('REMOTE_MISMATCH', 'Git remote does not match the selected GitLab instance and project'); return target
}
export async function remote(cwd, connection, project, name) {
  const names = (await git(cwd, ['remote'])).split('\n').filter(Boolean)
  for (const item of name ? [name] : names) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(item) || !names.includes(item)) continue; const fetchUrls = (await git(cwd, ['remote', 'get-url', '--all', item])).split('\n'); const pushUrls = (await git(cwd, ['remote', 'get-url', '--push', '--all', item])).split('\n'); if (fetchUrls.length !== 1 || pushUrls.length !== 1) continue; try { verifyTarget(fetchUrls[0], connection, project); verifyTarget(pushUrls[0], connection, project); return { name: item, fetchUrl: fetchUrls[0], pushUrl: pushUrls[0] } } catch {} }
  fail('REMOTE_MISMATCH', 'No single fetch/push remote matches the selected GitLab project')
}
export async function commit(cwd, ref) { const sha = await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]); if (!/^[0-9a-f]{40,64}$/.test(sha)) fail('INVALID_COMMIT', 'Invalid Git commit'); return sha }
export async function localBase(cwd, remoteName, target) { branch(target); for (const ref of [`refs/remotes/${remoteName}/${target}`, `refs/heads/${target}`]) { try { return { ref, sha: await commit(cwd, ref) } } catch {} }; fail('LOCAL_REF_MISSING', 'Target branch is not available locally; fetch it manually with your existing Git authentication') }
export async function contained(directory, subdir) { const relative = subdirectory(subdir); const target = await realpath(path.resolve(directory, relative)).catch(() => fail('INVALID_SUBDIRECTORY', 'Execution subdirectory does not exist')); if (target !== directory && !target.startsWith(directory + path.sep)) fail('INVALID_SUBDIRECTORY', 'Execution subdirectory escapes the worktree'); if (!(await stat(target)).isDirectory()) fail('INVALID_SUBDIRECTORY', 'Execution path is not a directory'); return target }
/** Fixed local-only observation; no caller-supplied paths or Git options. */
export async function inspect(directory, baseCommit) {
  const headSha = await commit(directory, 'HEAD'), currentBranch = await git(directory, ['symbolic-ref', '--short', 'HEAD'])
  const dirty = await git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { truncate: true })
  const changed = await git(directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', `${baseCommit}..${headSha}`, '--'], { truncate: true })
  const parts = changed.text.split('\0'), files = []
  for (let i = 0; i + 1 < parts.length && files.length < 1000; i += 2) if (parts[i] && parts[i + 1]) files.push({ path: parts[i + 1], status: parts[i] })
  const patch = await git(directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3', `${baseCommit}..${headSha}`, '--'], { truncate: true, maxBuffer: 64 * 1024 })
  if (await commit(directory, 'HEAD') !== headSha) fail('HEAD_CHANGED', 'HEAD changed during inspection; inspect again')
  return { headSha, branch: currentBranch, clean: !dirty.text && !dirty.truncated, dirty: { status: dirty.text.slice(0, 16384).replaceAll('\0', '\n'), truncated: dirty.truncated || dirty.text.length > 16384 }, files, filesTruncated: changed.truncated || parts.length > 2001, diff: patch.text.slice(0, 65536), diffTruncated: patch.truncated || patch.text.length > 65536 }
}
export async function cleanHead(directory, expectedBranch) { const current = await git(directory, ['symbolic-ref', '--short', 'HEAD']); if (current !== expectedBranch) fail('HEAD_CHANGED', 'Environment branch changed'); if (await git(directory, ['status', '--porcelain=v1', '--untracked-files=normal'])) fail('DIRTY_WORKTREE', 'Commit all changes before preparing or publishing delivery'); return commit(directory, 'HEAD') }

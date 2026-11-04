import test from 'node:test'
import assert from 'node:assert/strict'
import { baseUrl } from '../host/security.js'
import { GitLabApi } from '../host/api.js'
import { dispatch, route, USER_ACTIONS, toolParameters } from '../host/dispatch.js'
import { remoteTarget, verifyTarget } from '../host/git.js'

test('HTTPS base URL rejects credential leakage and ambiguous API roots', () => {
  assert.equal(baseUrl('https://git.example/team/'), 'https://git.example/team')
  for (const value of ['http://git.example', 'https://user:secret@git.example', 'https://git.example?q=token', 'https://git.example/#token', 'https://git.example/%2fhidden', 'file:///tmp']) assert.throws(() => baseUrl(value))
})
test('API uses credential records, disables redirects, bounds and redacts responses', async () => {
  const seen = [], credentials = { readRecord: async key => { assert.equal(key, 'local.gitlab-panel.c'); return { kind: 'api-key', key: 'secret-pat' } } }
  const api = new GitLabApi({ credentials, fetch: async (url, init) => { seen.push({ url, init }); return Response.json({ id: 42, username: 'secret-pat', name: 'User' }) } })
  assert.deepEqual(await api.identity({ id: 'c', baseUrl: 'https://git.example' }), { id: 42, username: '[credential redacted]', name: 'User' })
  assert.equal(seen[0].init.redirect, 'error'); assert.equal(seen[0].init.headers['PRIVATE-TOKEN'], 'secret-pat'); assert.equal(seen[0].url, 'https://git.example/api/v4/user')
  const bad = new GitLabApi({ credentials, fetch: async () => { throw Error('secret-pat') } })
  await assert.rejects(bad.identity({ id: 'c', baseUrl: 'https://git.example' }), e => !e.message.includes('secret-pat') && e.code === 'NETWORK_UNKNOWN')
  const huge = new GitLabApi({ credentials, fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) })
  await assert.rejects(huge.identity({ id: 'c', baseUrl: 'https://git.example' }), { code: 'RESPONSE_TOO_LARGE' })
})
test('git remote verification rejects embedded secrets, foreign projects and protocols', () => {
  const c = { baseUrl: 'https://git.example' }, p = { pathWithNamespace: 'group/repo' }
  for (const remote of ['git@git.example:group/repo.git', 'https://git.example/group/repo.git', 'ssh://git@git.example:2222/group/repo.git']) assert.doesNotThrow(() => verifyTarget(remote, c, p))
  for (const remote of ['https://user:pat@git.example/group/repo.git', 'file:///tmp/repo', 'ext::command', 'git@evil.example:group/repo', 'git@git.example:other/repo', 'https://git.example/group/%72epo']) assert.throws(() => verifyTarget(remote, c, p))
  assert.deepEqual(remoteTarget('git@git.example:group/repo.git'), { host: 'git.example', project: 'group/repo' })
  const custom = { baseUrl: 'https://git.example:8443/gitlab' }
  assert.doesNotThrow(() => verifyTarget('https://git.example:8443/gitlab/group/repo.git', custom, p))
  assert.doesNotThrow(() => verifyTarget('ssh://git@git.example:2222/group/repo.git', custom, p))
  for (const remote of ['https://git.example/gitlab/group/repo.git', 'https://git.example:8443/group/repo.git', 'https://git.example:8443/other/group/repo.git']) assert.throws(() => verifyTarget(remote, custom, p))
})
test('every user-only action is denied before application access to agents', async () => {
  const service = new Proxy({}, { get() { throw Error('should not touch service') } })
  for (const action of USER_ACTIONS) assert.equal((await dispatch(service, { action, confirm: true }, 'agent')).error.code, 'USER_ONLY')
  assert.ok(!toolParameters.properties.action.enum.includes('pushDelivery')); assert.ok(!toolParameters.properties.action.enum.includes('saveConnection'))
})
test('route admits authenticated browser peer only for user authority', async () => {
  let called = 0
  const service = { saveConnection: async () => { called++; return { id: 'c' } }, status: async () => ({ connections: [] }) }
  const request = body => new Request('https://dsh.example/api/gitlab-panel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let admission = { rejection: 401 }
  const r = route({ browserPeer: { id: 'browser' }, admit: () => admission }, service)
  assert.equal((await r.fetch(request({ action: 'saveConnection' }))).status, 401)
  admission = { peer: { id: 'api-agent' } }
  assert.equal((await (await r.fetch(request({ action: 'saveConnection', confirm: true }))).json()).error.code, 'USER_ONLY'); assert.equal(called, 0)
  assert.deepEqual(await (await r.fetch(request({ action: 'status' }))).json(), { ok: true, data: { connections: [] } })
  admission = { peer: { id: 'browser' } }
  assert.deepEqual(await (await r.fetch(request({ action: 'saveConnection' }))).json(), { ok: true, data: { id: 'c' } }); assert.equal(called, 1)
  const oversized = new Request('https://dsh.example/api/gitlab-panel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(65537) })
  assert.equal((await r.fetch(oversized)).status, 413)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { GitLabWorkspace } from '../host/workspace.js'
import { GitLabApi } from '../host/api.js'
import { domainSpec } from '../host/storage.js'
import { dispatch } from '../host/dispatch.js'

const input = { action: 'saveConnection', name: 'Synthetic', baseUrl: 'https://git.example', token: 'SYNTHETIC-TEST-PAT' }
function fixture(credentials, { failConnection = false } = {}) {
  const maps = new Map(Object.keys(domainSpec.tables).map(name => [name, new Map()]))
  const domain = { close: async () => {}, table: name => ({ get: key => structuredClone(maps.get(name).get(key)), entries: () => maps.get(name).entries(), put: async (key, value) => { if (failConnection && name === 'connections') throw Error(input.token); domainSpec.tables[name].valueSchema.parse(value); maps.get(name).set(key, structuredClone(value)) } }) }
  let identityCalls = 0
  const api = new GitLabApi({ credentials, fetch: async () => { identityCalls++; return Response.json({ id: 42, username: 'synthetic', name: 'Synthetic' }) } })
  const ctx = { get: key => ({ credentials, storageDomain: { open: async () => domain } })[key] }
  const service = new GitLabWorkspace(ctx, { api })
  return { service, api, maps, count: () => identityCalls }
}
function strictCredentials() {
  const records = new Map()
  const admit = key => assert.match(key, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/, 'native CredentialKey grammar')
  return { records, readRecord: async key => { admit(key); return records.get(key) }, describeRecord: async key => { admit(key); return { configured: records.has(key), writable: true } }, modifyRecord: async (key, mutate) => { admit(key); const next = await mutate(records.get(key)); records.set(key, next); return next }, deleteRecord: async key => { admit(key); records.delete(key) } }
}

test('saveConnection uses native credential namespace and remains readable after saving', async () => {
  const credentials = strictCredentials(), f = fixture(credentials)
  const saved = await dispatch(f.service, input, 'user')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(f.count(), 1)
  const key = f.api.key(saved.data.id)
  assert.match(key, /^gitlab-panel\/[a-z][a-z0-9-]*$/)
  assert.equal((await f.service.status()).connections[0].credentialConfigured, true)
  assert.equal((await f.api.identity(saved.data)).id, 42)
  assert.ok(!JSON.stringify(await f.service.status()).includes(input.token))
  await f.service.disconnect({ connectionId: saved.data.id, confirm: true })
  assert.equal(credentials.records.size, 0)
  await f.service.dispose()
})

test('credential addresses are stable and valid even for legacy connection ids', () => {
  const api = new GitLabApi({ credentials: {} })
  const ids = ['connection-123', 'Legacy.ID:2', '123', 'c']
  const keys = ids.map(id => api.key(id))
  for (let i = 0; i < ids.length; i++) { assert.match(keys[i], /^gitlab-panel\/[a-z][a-z0-9-]*$/); assert.equal(api.key(ids[i]), keys[i]) }
  assert.equal(new Set(keys).size, ids.length)
})

test('native credential write failure reports verified-identity stage without leaking secrets', async () => {
  const f = fixture({ modifyRecord: async () => { throw Error(input.token) } })
  const result = await dispatch(f.service, input, 'user')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CREDENTIAL_SAVE_FAILED')
  assert.match(result.error.message, /identity verified/i)
  assert.ok(!JSON.stringify(result).includes(input.token))
  assert.equal(f.count(), 1); assert.equal(f.maps.get('connections').size, 0)
  await f.service.dispose()
})

test('metadata save uncertainty is distinguished from a credential failure', async () => {
  const credentials = strictCredentials(), f = fixture(credentials, { failConnection: true })
  const result = await dispatch(f.service, input, 'user')
  assert.equal(result.error.code, 'CONNECTION_SAVE_UNKNOWN')
  assert.equal(credentials.records.size, 1)
  assert.ok(!JSON.stringify(result).includes(input.token))
  await f.service.dispose()
})

test('GitLab identity rejection stays distinct and never writes credentials', async () => {
  let writes = 0
  const credentials = { modifyRecord: async () => { writes++ } }, f = fixture(credentials)
  f.api.fetch = async () => new Response('', { status: 401 })
  const result = await dispatch(f.service, input, 'user')
  assert.equal(result.error.code, 'GITLAB_HTTP'); assert.equal(writes, 0)
  await f.service.dispose()
})

for (const [code, error] of [
  ['CREDENTIAL_STORE_PERMISSION', Object.assign(Error(input.token), { code: 'EACCES' })],
  ['CREDENTIAL_STORE_FORMAT', new TypeError(`credential key "${input.token}" must be "<scope>/<id>"`)],
]) test(`credential storage reports ${code} without exposing provider diagnostics`, async () => {
  const f = fixture({ modifyRecord: async () => { throw error } })
  const result = await dispatch(f.service, input, 'user')
  assert.equal(result.error.code, code); assert.match(result.error.message, /identity verified/i)
  assert.ok(!JSON.stringify(result).includes(input.token)); assert.equal(f.maps.get('connections').size, 0)
  await f.service.dispose()
})

const nativeEntry = process.env.DSH_TEST_CREDENTIALS_LOCAL_MODULE
// This integration reads only a synthetic private file, never the user's store.
test('installed native credential provider cold-reopens a saved GitLab connection', { skip: !nativeEntry }, async t => {
  const require = createRequire(pathToFileURL(path.resolve(nativeEntry)))
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
  const { LocalCredentialProvider, parseCredentialsDocument } = await import(pathToFileURL(path.resolve(nativeEntry)))
  const directory = await mkdtemp(path.join(tmpdir(), 'gitlab-native-credential-'))
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.join(tmpdir(), 'gitlab-native-credential-'))); await rm(directory, { recursive: true, force: true }) })
  const filename = path.join(directory, 'synthetic.yaml')
  const provider = new LocalCredentialProvider(new Context(), { path: filename, watch: false })
  await provider.loadInitial()
  const f = fixture(provider)
  const result = await dispatch(f.service, input, 'user')
  assert.equal(result.ok, true, JSON.stringify(result))
  const savedText = await readFile(filename, 'utf8')
  assert.doesNotThrow(() => parseCredentialsDocument(savedText, 'synthetic.yaml'))
  const cold = new LocalCredentialProvider(new Context(), { path: filename, watch: false })
  await cold.loadInitial()
  assert.equal((await cold.describeRecord(f.api.key(result.data.id))).configured, true)
  assert.equal((await cold.readRecord(f.api.key(result.data.id))).key, input.token)
  await f.service.dispose()
  // The synthetic legacy key really is refused by the runtime parser.
  assert.throws(() => parseCredentialsDocument('version: 1\nrecords:\n  local.gitlab-panel.connection-synthetic:\n    kind: api-key\n    key: SYNTHETIC\n', 'synthetic.yaml'), /<scope>\/<id>/)
})

import { baseUrl, boundedBody, fail, projectId, pageNumber, safeWebUrl, text } from './security.js'
const enc = encodeURIComponent
export function projectView(p, base) { return { id: projectId(p.id), name: String(p.name ?? '').slice(0, 256), pathWithNamespace: text(p.path_with_namespace, 'project path', 1000), defaultBranch: p.default_branch ? String(p.default_branch).slice(0, 240) : null, webUrl: safeWebUrl(p.web_url, base) } }
export function mrView(m, base) { return { id: m.id, iid: m.iid, title: String(m.title ?? '').slice(0, 256), description: String(m.description ?? '').slice(0, 12000), sourceBranch: String(m.source_branch ?? '').slice(0, 240), targetBranch: String(m.target_branch ?? '').slice(0, 240), sha: String(m.sha ?? ''), state: String(m.state ?? ''), draft: m.draft === true || /^Draft:/i.test(m.title ?? ''), webUrl: safeWebUrl(m.web_url, base) } }
export class GitLabApi {
  constructor({ credentials, fetch = globalThis.fetch }) { this.credentials = credentials; this.fetch = fetch }
  key(id) { return `local.gitlab-panel.${id}` }
  async request(connection, path, { method = 'GET', body, token, allow404 = false } = {}) {
    const base = baseUrl(connection.baseUrl)
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) fail('INVALID_ARGUMENT', 'Invalid API path')
    if (!token) { const record = await this.credentials.readRecord(this.key(connection.id)); if (record?.kind !== 'api-key' || !record.key) fail('CREDENTIAL_MISSING', 'Reconnect this GitLab identity in the panel'); token = record.key }
    let response
    try { response = await this.fetch(`${base}/api/v4${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }) } catch { fail('NETWORK_UNKNOWN', method === 'GET' ? 'GitLab request failed or redirected' : 'GitLab write outcome is unknown; verify before retrying') }
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null }
    if (!response.ok) { await response.body?.cancel(); try { fail('GITLAB_HTTP', `GitLab returned HTTP ${response.status}`) } catch (error) { error.httpStatus = response.status; throw error } }
    let result; try { result = JSON.parse(await boundedBody(response)) } catch (error) { if (error?.code === 'RESPONSE_TOO_LARGE') throw error; fail('INVALID_RESPONSE', 'GitLab returned invalid JSON') }
    // Even a misbehaving server cannot echo this request's PAT into UI/tool/state.
    const redact = value => typeof value === 'string' ? value.split(token).join('[credential redacted]') : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(token).join('[credential redacted]'), redact(item)])) : value
    return redact(result)
  }
  async identity(c, token) { const u = await this.request(c, '/user', { token }); if (!Number.isSafeInteger(u.id) || u.id < 1) fail('INVALID_RESPONSE', 'GitLab did not return a valid user identity'); return { id: u.id, username: String(u.username ?? '').slice(0, 160), name: String(u.name ?? '').slice(0, 256) } }
  async assertIdentity(c) { const identity = await this.identity(c); if (identity.id !== c.identity.id) fail('IDENTITY_CHANGED', 'Stored GitLab identity changed; create a new connection instead'); return identity }
  async project(c, id) { return projectView(await this.request(c, `/projects/${projectId(id)}`), c.baseUrl) }
  async projects(c, search = '', page = 1) { if (typeof search !== 'string' || search.length > 256) fail('INVALID_ARGUMENT', 'search must be at most 256 characters'); const rows = await this.request(c, `/projects?membership=true&simple=true&order_by=id&sort=asc&per_page=30&page=${pageNumber(page)}&search=${enc(search)}`); if (!Array.isArray(rows) || rows.length > 30) fail('INVALID_RESPONSE', 'Invalid project page'); return rows.map(p => projectView(p, c.baseUrl)) }
  async branches(c, id, page = 1) { const rows = await this.request(c, `/projects/${projectId(id)}/repository/branches?per_page=30&page=${pageNumber(page)}`); if (!Array.isArray(rows) || rows.length > 30) fail('INVALID_RESPONSE', 'Invalid branch page'); return rows.map(b => ({ name: String(b.name ?? '').slice(0, 240), default: b.default === true, protected: b.protected === true, commit: { id: String(b.commit?.id ?? '') } })) }
  async mergeRequests(c, id, page = 1, source) { const rows = await this.request(c, `/projects/${projectId(id)}/merge_requests?state=opened&per_page=30&page=${pageNumber(page)}${source ? `&source_branch=${enc(source)}` : ''}`); if (!Array.isArray(rows) || rows.length > 30) fail('INVALID_RESPONSE', 'Invalid merge request page'); return rows.map(m => mrView(m, c.baseUrl)) }
  async exactMr(c, id, iid) { const p = projectId(id), i = projectId(iid); const raw = await this.request(c, `/projects/${p}/merge_requests/${i}`); if (String(raw.iid) !== i || (raw.project_id !== undefined && String(raw.project_id) !== p)) fail('INVALID_RESPONSE', 'Exact MR identity mismatch'); return mrView(raw, c.baseUrl) }
  async reviewRequests(c, page = 1) {
    const identity = await this.assertIdentity(c)
    const rows = await this.request(c, `/merge_requests?scope=all&state=opened&reviewer_id=${identity.id}&per_page=30&page=${pageNumber(page)}`)
    if (!Array.isArray(rows) || rows.length > 30) fail('INVALID_RESPONSE', 'Invalid review request page')
    return rows.map(m => ({ ...mrView(m, c.baseUrl), projectId: projectId(m.project_id) }))
  }
  async readReview(c, id, iid) {
    const p = projectId(id), i = projectId(iid), prefix = `/projects/${p}/merge_requests/${i}`
    const section = async fn => { try { return { status: 'available', data: await fn() } } catch (error) { return { status: 'unavailable', reason: error.httpStatus ? `HTTP_${error.httpStatus}` : error.code ?? 'OPERATION_FAILED' } } }
    const page = async suffix => { const rows = await this.request(c, `${prefix}/${suffix}?per_page=30&page=1`); if (!Array.isArray(rows) || rows.length > 30) fail('INVALID_RESPONSE', 'Invalid review page'); return rows }
    const note = n => ({ id: n.id, body: String(n.body ?? '').slice(0, 4000), bodyTruncated: String(n.body ?? '').length > 4000, author: String(n.author?.username ?? '').slice(0, 160), createdAt: String(n.created_at ?? '').slice(0, 100), resolved: typeof n.resolved === 'boolean' ? n.resolved : null, resolvable: n.resolvable === true, system: n.system === true })
    const mr = await section(() => this.exactMr(c, p, i))
    const pipeline = await section(async () => {
      const rows = await page('pipelines')
      // An empty list alone does not establish that CI is not configured.
      if (!rows.length) { let project; try { project = await this.request(c, `/projects/${p}`) } catch {} ; return project?.jobs_enabled === false || project?.builds_enabled === false ? { state: 'not_configured', reason: 'Project CI is explicitly disabled', items: [] } : { state: 'unknown', reason: 'No MR pipeline observed; CI configuration is not established', items: [] } }
      const current = mr.status === 'available' && rows.filter(r => r.sha && r.sha === mr.data.sha).sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0]
      const states = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'scheduled']
      return { state: current && states.includes(current.status) ? current.status : 'unknown', headSha: mr.status === 'available' ? mr.data.sha : null, items: rows.map(r => ({ id: r.id, sha: String(r.sha ?? ''), status: states.includes(r.status) ? r.status : 'unknown', webUrl: safeWebUrl(r.web_url, c.baseUrl) })), hasMore: rows.length === 30 }
    })
    const discussions = await section(async () => { const rows = await page('discussions'); return { items: rows.map(d => ({ id: String(d.id ?? '').slice(0, 160), notes: (Array.isArray(d.notes) ? d.notes : []).slice(0, 30).map(note), notesTruncated: Array.isArray(d.notes) && d.notes.length > 30 })), hasMore: rows.length === 30 } })
    const notes = await section(async () => { const rows = await page('notes'); return { items: rows.map(note), hasMore: rows.length === 30 } })
    const approvals = await section(async () => { const a = await this.request(c, `${prefix}/approvals`); return { approved: typeof a.approved === 'boolean' ? a.approved : null, approvalsRequired: Number.isSafeInteger(a.approvals_required) ? a.approvals_required : null, approvalsLeft: Number.isSafeInteger(a.approvals_left) ? a.approvals_left : null, approvedBy: (Array.isArray(a.approved_by) ? a.approved_by : []).slice(0, 30).map(v => ({ id: v.user?.id, username: String(v.user?.username ?? '').slice(0, 160) })) } })
    return { connectionId: c.id, projectId: p, mrIid: Number(i), mr, pipeline, discussions, notes, approvals, observedAt: new Date().toISOString() }
  }
  async remoteBranch(c, id, name) { return this.request(c, `/projects/${projectId(id)}/repository/branches/${enc(name)}`, { allow404: true }) }
}

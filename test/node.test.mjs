import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const HAPTI = process.env.HAPTI_SERVER ?? `${process.env.HOME}/codes/hapti/server.mjs`;

process.env.HAPTI_DB = ':memory:';
process.env.HAPTI_SECRET = 'test-secret-that-is-long-enough-0123456789';
process.env.HAPTI_ADMIN_TOKEN = 'admin_test_token_0123456789abcdef';

const engine = { tasks: new Map(), n: 0 };
const engineServer = createServer(async (req, res) => {
  let s = '';
  for await (const c of req) s += c;
  const send = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/healthz') return send(200, { ok: true, running: 0 });
  if (req.url === '/v1/tasks' && req.method === 'POST') {
    const id = `task_${(++engine.n).toString(16).padStart(6, '0')}`;
    const body = JSON.parse(s);
    const asks = /code/.test(body.goal);
    engine.tasks.set(id, asks ? { id, status: 'waiting', pending: { type: 'question', key: 'code', text: 'Which code?' }, result: null, usage: null } : { id, status: 'succeeded', pending: null, result: { answer: `Done: ${body.goal}`, data: { total: 42.5 } }, usage: { steps: 6 } });
    return send(201, { id, status: 'running' });
  }
  const m = req.url.match(/^\/v1\/tasks\/(task_[0-9a-f]+)(?:\/(answer|cancel|proof))?$/);
  const t = m && engine.tasks.get(m[1]);
  if (!t) return send(404, {});
  if (m[2] === 'proof') return send(200, { events: [], screenshots: [] });
  if (m[2] === 'answer') Object.assign(t, { status: 'succeeded', pending: null, result: { answer: `code ${JSON.parse(s).value}` }, usage: { steps: 3 } });
  if (m[2] === 'cancel') Object.assign(t, { status: 'cancelled', pending: null });
  send(200, t);
});

let hapti;
let base;
let key;
before(async () => {
  await new Promise((ok) => engineServer.listen(0, '127.0.0.1', ok));
  process.env.HAPTI_ENGINES = `http://127.0.0.1:${engineServer.address().port}|k|5`;
  const { start } = await import(HAPTI);
  hapti = await start({ port: 0, every: 500 });
  base = `http://127.0.0.1:${hapti.address().port}`;
  const r = await fetch(`${base}/admin/orgs`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HAPTI_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{"name":"n8n"}' }).then((x) => x.json());
  await fetch(`${base}/admin/orgs/${r.org.id}/credit`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HAPTI_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{"cents":10000}' });
  key = r.keys.find((k) => k.mode === 'test').secret;
});
after(() => {
  hapti.close();
  engineServer.close();
});

const { Hapti } = require('../dist/nodes/Hapti/Hapti.node.js');
const { HaptiApi } = require('../dist/credentials/HaptiApi.credentials.js');

async function runNode(params, { credentials } = {}) {
  const cred = new HaptiApi();
  const creds = credentials ?? { apiKey: key, baseUrl: base };
  const ctx = {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
    getCredentials: async () => creds,
    getNode: () => ({ name: 'Hapti', type: 'n8n-nodes-hapti.hapti', typeVersion: 1, parameters: {} }),
    continueOnFail: () => false,
    helpers: {
      httpRequestWithAuthentication: async function (name, opts) {
        assert.equal(name, 'haptiApi');
        const headers = Object.fromEntries(Object.entries(cred.authenticate.properties.headers).map(([k, v]) => [k, String(v).replace('={{$credentials.apiKey}}', creds.apiKey).replace(/^=Bearer \{\{\$credentials\.apiKey\}\}$/, `Bearer ${creds.apiKey}`)]));
        const r = await fetch(opts.url, { method: opts.method, headers: { ...headers, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
        const data = await r.json();
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`), { httpCode: String(r.status) });
        return data;
      },
    },
  };
  const [[out]] = await new Hapti().execute.call(ctx);
  return out.json;
}

test('the node is described for n8n: a resource, six operations, a credential checked on the billing endpoint', () => {
  const d = new Hapti().description;
  assert.equal(d.name, 'hapti');
  assert.equal(d.usableAsTool, true);
  assert.deepEqual(d.properties.find((p) => p.name === 'operation').options.map((o) => o.value).sort(), ['answer', 'approve', 'cancel', 'create', 'get', 'run']);
  const c = new HaptiApi();
  assert.equal(c.name, 'haptiApi');
  assert.equal(c.test.request.url, '/v1/billing');
  assert.equal(c.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
});

test('Run starts a task with its data and schema and waits for the result', async () => {
  const t = await runNode({ resource: 'task', operation: 'run', url: 'https://portal.example.com', goal: 'Download the latest invoice', waitMinutes: 2, options: { data: '{"contract":"AX-1"}', output: '{"type":"object","properties":{"total":{"type":"number"}}}', user: 'claire', max_seconds: 300 } });
  assert.equal(t.status, 'succeeded');
  assert.match(t.result.answer, /Download the latest invoice/);
  assert.equal(t.user, 'claire');
  const got = await runNode({ resource: 'task', operation: 'get', taskId: t.id });
  assert.equal(got.id, t.id);
  assert.equal(got.status, 'succeeded');
});

test('Run returns a waiting task with its question, Answer resumes it to the end', async () => {
  const t = await runNode({ resource: 'task', operation: 'run', url: 'https://bank.example.com', goal: 'Sign in with the code sent by text', waitMinutes: 1, options: {} });
  assert.equal(t.status, 'waiting');
  assert.equal(t.pending.text, 'Which code?');
  await runNode({ resource: 'task', operation: 'answer', taskId: t.id, value: '731004' });
  let end;
  for (let i = 0; i < 20; i++) {
    end = await runNode({ resource: 'task', operation: 'get', taskId: t.id });
    if (end.status === 'succeeded') break;
    await new Promise((ok) => setTimeout(ok, 300));
  }
  assert.equal(end.status, 'succeeded');
  assert.match(end.result.answer, /731004/);
});

test('Start returns at once, Cancel stops a task, a bad key and bad JSON fail clearly', async () => {
  const t = await runNode({ resource: 'task', operation: 'create', url: 'https://bank.example.com', goal: 'Sign in with the code sent by text', options: {} });
  assert.ok(['queued', 'running', 'waiting'].includes(t.status), t.status);
  const c = await runNode({ resource: 'task', operation: 'cancel', taskId: t.id });
  assert.equal(c.status, 'cancelled');
  await assert.rejects(runNode({ resource: 'task', operation: 'get', taskId: t.id }, { credentials: { apiKey: 'hp_test_wrong', baseUrl: base } }), /Authorization failed/);
  await assert.rejects(runNode({ resource: 'task', operation: 'create', url: 'https://x.example', goal: 'x', options: { data: '{not json' } }), /Data is not valid JSON/);
});

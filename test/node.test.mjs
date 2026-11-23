import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const HAPTI = process.env.HAPTI_SERVER ?? `${process.env.HOME}/codes/hapti/server.mjs`;

process.env.HAPTI_DB = ':memory:';
process.env.HAPTI_SECRET = 'test-secret-that-is-long-enough-0123456789';
process.env.HAPTI_ADMIN_TOKEN = 'admin_test_token_0123456789abcdef';
process.env.HAPTI_SCHEDULE_MIN_MINUTES = '1';
const site = { total: 42.5 };

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
    engine.tasks.set(id, asks ? { id, status: 'waiting', pending: { type: 'question', key: 'code', text: 'Which code?' }, result: null, usage: null } : { id, status: 'succeeded', pending: null, result: { answer: `Done: ${body.goal}`, data: { total: site.total } }, usage: { steps: 6 } });
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
let runDue;
before(async () => {
  await new Promise((ok) => engineServer.listen(0, '127.0.0.1', ok));
  process.env.HAPTI_ENGINES = `http://127.0.0.1:${engineServer.address().port}|k|5`;
  const { start } = await import(HAPTI);
  ({ runDue } = await import(HAPTI.replace(/server\.mjs$/, 'lib/schedules.mjs')));
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
const { HaptiTrigger } = require('../dist/nodes/HaptiTrigger/HaptiTrigger.node.js');

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
      assertBinaryData: (_i, property) => {
        if (property !== 'attachment_0') throw new Error(`no binary property ${property}`);
        return { fileName: 'claim-email.png', mimeType: 'image/png' };
      },
      getBinaryDataBuffer: async () => Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
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
  const [out] = await new Hapti().execute.call(ctx);
  return params.many ? out.map((o) => o.json) : out[0].json;
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

test('Files sends the binary properties of the item, which the task then lists', async () => {
  const t = await runNode({ resource: 'task', operation: 'create', url: 'https://portal.example.com', goal: 'Fill the claim from the email screenshot', options: { files: 'attachment_0' } });
  assert.deepEqual(t.input.files, ['claim-email.png']);
  await assert.rejects(runNode({ resource: 'task', operation: 'create', url: 'https://portal.example.com', goal: 'x', options: { files: 'missing' } }), /no binary property missing/);
});

const httpWith = (creds) => async function (name, opts) {
  const r = await fetch(opts.url, { method: opts.method, headers: { Authorization: `Bearer ${creds.apiKey}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { httpCode: String(r.status) });
  return data;
};
const until = async (check) => {
  for (let i = 0; i < 100; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('timed out');
};

test('Monitor: watch a website, read its current value and changes, list and delete', async () => {
  const m = await runNode({ resource: 'monitor', operation: 'watch', monitorUrl: 'https://shop.example.com/lamp', monitorGoal: 'Read the price of the lamp', every: '1h', monitorOptions: { output: '{"type":"object","properties":{"total":{"type":"number"}}}', name: 'Lamp', timezone: 'Europe/Paris' } });
  assert.match(m.id, /^mon_/);
  assert.equal(m.every, '60m');
  await runDue(Date.now() + 1000);
  const v = await until(async () => { const x = await runNode({ resource: 'monitor', operation: 'latest', monitorId: m.id }); return x.value ? x : null; });
  assert.deepEqual(v.value, { total: 42.5 });
  const changes = await runNode({ resource: 'monitor', operation: 'changes', monitorId: m.id, limit: 10, many: true });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].first, true);
  assert.ok((await runNode({ resource: 'monitor', operation: 'list', many: true })).some((x) => x.id === m.id));
  assert.equal((await runNode({ resource: 'monitor', operation: 'remove', monitorId: m.id })).deleted, true);
});

test('Hapti Trigger starts the workflow once for each new change, never twice, and shows the latest one when tested', async () => {
  const creds = { apiKey: key, baseUrl: base };
  const state = {};
  const pollCtx = (mode, monitorId) => ({
    getCredentials: async () => creds,
    getWorkflowStaticData: () => state,
    getMode: () => mode,
    getNode: () => ({ name: 'Hapti Trigger', type: 'n8n-nodes-hapti.haptiTrigger', typeVersion: 1, parameters: {} }),
    getNodeParameter: (name, fallback) => (name === 'monitorId' ? monitorId : fallback),
    helpers: { httpRequestWithAuthentication: httpWith(creds), returnJsonArray: (a) => a.map((json) => ({ json })) },
  });
  const trigger = new HaptiTrigger();
  assert.equal(trigger.description.polling, true);
  site.total = 42.5;
  assert.equal(await trigger.poll.call(pollCtx('trigger', '')), null, 'the first poll only starts from now');
  await new Promise((ok) => setTimeout(ok, 5));
  const m = await runNode({ resource: 'monitor', operation: 'watch', monitorUrl: 'https://shop.example.com/desk', monitorGoal: 'Read the price of the desk', every: '1h', monitorOptions: { output: '{"type":"object","properties":{"total":{"type":"number"}}}' } });
  await runDue(Date.now() + 1000);
  await until(async () => (await runNode({ resource: 'monitor', operation: 'changes', monitorId: m.id, many: true })).length === 1);
  const [first] = await trigger.poll.call(pollCtx('trigger', m.id));
  assert.equal(first.length, 1);
  assert.equal(first[0].json.monitor, m.id);
  assert.equal(first[0].json.url, 'https://shop.example.com/desk');
  assert.equal(first[0].json.first, true);
  assert.equal(await trigger.poll.call(pollCtx('trigger', m.id)), null, 'a change is never sent twice');
  site.total = 39.9;
  await runDue(Date.now() + 2 * 3600e3);
  await until(async () => (await runNode({ resource: 'monitor', operation: 'changes', monitorId: m.id, many: true })).length === 2);
  const [second] = await trigger.poll.call(pollCtx('trigger', ''));
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].json.changed.map((c) => [c.before.total, c.after.total]), [[42.5, 39.9]]);
  const [tested] = await trigger.poll.call(pollCtx('manual', m.id));
  assert.equal(tested.length, 1);
  assert.equal(tested[0].json.changed[0].after.total, 39.9);
});

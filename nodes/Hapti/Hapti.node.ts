import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

const FINAL = ['succeeded', 'failed', 'blocked', 'incomplete', 'needs_person', 'cancelled'];

const parseJson = (ctx: IExecuteFunctions, value: unknown, field: string, itemIndex: number): IDataObject | undefined => {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'object') return value as IDataObject;
	try {
		return JSON.parse(String(value)) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${field} is not valid JSON`, { itemIndex });
	}
};

export class Hapti implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hapti',
		name: 'hapti',
		icon: { light: 'file:hapti.svg', dark: 'file:hapti.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Do tasks on websites that have no API: an agent uses a real browser by sight and returns the result with proof',
		defaults: { name: 'Hapti' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'haptiApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'task',
				options: [
					{ name: 'Monitor', value: 'monitor', description: 'Watch a website on a schedule and get only what changed' },
					{ name: 'Task', value: 'task' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'run',
				displayOptions: { show: { resource: ['task'] } },
				options: [
					{ name: 'Answer', value: 'answer', action: 'Answer a question', description: 'Give the value a waiting task asked for' },
					{ name: 'Approve or Refuse', value: 'approve', action: 'Approve or refuse a step', description: 'Approve or refuse the step a waiting task asks about' },
					{ name: 'Cancel', value: 'cancel', action: 'Cancel a task', description: 'Stop a task, never billed' },
					{ name: 'Get', value: 'get', action: 'Get a task', description: 'Read the state and result of a task' },
					{ name: 'Run', value: 'run', action: 'Run a task and wait for its result', description: 'Start a task on a website and wait until it ends or needs someone' },
					{ name: 'Start', value: 'create', action: 'Start a task', description: 'Start a task and return at once' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'watch',
				displayOptions: { show: { resource: ['monitor'] } },
				options: [
					{ name: 'Delete', value: 'remove', action: 'Delete a monitor', description: 'Stop a monitor and delete its values and history' },
					{ name: 'Get Changes', value: 'changes', action: 'Get the changes of a monitor', description: 'What was added, removed or changed at each check, newest first' },
					{ name: 'Get Current Value', value: 'latest', action: 'Get the current value of a monitor', description: 'The last value read on the website, as if it had an API' },
					{ name: 'Get Many', value: 'list', action: 'Get many monitors', description: 'Every monitor with its schedule, last check and last change' },
					{ name: 'Watch a Website', value: 'watch', action: 'Watch a website', description: 'Check a website on a schedule and report only what changed' },
				],
			},
			{
				displayName: 'Website URL',
				name: 'monitorUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://www.agence-exemple.fr/locations',
				description: 'The page where each check starts',
				displayOptions: { show: { resource: ['monitor'], operation: ['watch'] } },
			},
			{
				displayName: 'What to Read',
				name: 'monitorGoal',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				placeholder: 'List the flats to rent in Lyon under 900 euros with their title, price and link.',
				description: 'What the agent reads on the website at each check, in plain words',
				displayOptions: { show: { resource: ['monitor'], operation: ['watch'] } },
			},
			{
				displayName: 'Every',
				name: 'every',
				type: 'string',
				default: '1h',
				placeholder: '30m, 1h, 1d',
				description: 'How often the website is checked. Each check is a task, billed only when it succeeds.',
				displayOptions: { show: { resource: ['monitor'], operation: ['watch'] } },
			},
			{
				displayName: 'Monitor ID',
				name: 'monitorId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'mon_...',
				displayOptions: { show: { resource: ['monitor'], operation: ['latest', 'changes', 'remove'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['monitor'], operation: ['changes'] } },
			},
			{
				displayName: 'Options',
				name: 'monitorOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['monitor'], operation: ['watch'] } },
				options: [
					{ displayName: 'Cron Rule', name: 'cron', type: 'string', default: '', placeholder: '0 8 * * 1-5', description: 'Check on a cron rule instead of Every' },
					{ displayName: 'Item Key', name: 'key', type: 'string', default: '', placeholder: 'url', description: 'The field that names an item of the list, such as the URL or a reference, so a price change is seen as a change and not as a new item' },
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Notify After Every Check', name: 'always', type: 'boolean', default: false, description: 'Whether to also send monitor.checked after every check, not only monitor.changed' },
					{ displayName: 'Output Schema (JSON)', name: 'output', type: 'json', default: '', description: 'A JSON Schema for the value read. Give one: a list inside is compared item by item.' },
					{ displayName: 'Time Zone', name: 'timezone', type: 'string', default: '', placeholder: 'Europe/Paris' },
					{ displayName: 'User', name: 'user', type: 'string', default: '', description: 'The person the checks are done for, to use their sign-ins' },
					{ displayName: 'Webhook URL', name: 'webhook', type: 'string', default: '', description: 'An address that receives monitor.changed' },
				],
			},
			{
				displayName: 'Website URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://www.example.com',
				description: 'The page where the agent starts',
				displayOptions: { show: { resource: ['task'], operation: ['run', 'create'] } },
			},
			{
				displayName: 'Goal',
				name: 'goal',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				placeholder: 'Download the latest invoice and give its total and due date.',
				description: 'What the agent must do, in plain words, in any language',
				displayOptions: { show: { resource: ['task'], operation: ['run', 'create'] } },
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'tsk_...',
				displayOptions: { show: { resource: ['task'], operation: ['get', 'answer', 'approve', 'cancel'] } },
			},
			{
				displayName: 'Answer',
				name: 'value',
				type: 'string',
				default: '',
				required: true,
				description: 'The value the task asked for in pending.text',
				displayOptions: { show: { resource: ['task'], operation: ['answer'] } },
			},
			{
				displayName: 'Approve',
				name: 'approve',
				type: 'boolean',
				default: true,
				description: 'Whether to let the agent do the step it asked about',
				displayOptions: { show: { resource: ['task'], operation: ['approve'] } },
			},
			{
				displayName: 'Wait at Most (Minutes)',
				name: 'waitMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 15,
				description: 'How long the node waits for the task to end or to need someone before it returns the task as it is',
				displayOptions: { show: { resource: ['task'], operation: ['run'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['task'], operation: ['run', 'create'] } },
				options: [
					{ displayName: 'Data (JSON)', name: 'data', type: 'json', default: '{}', description: 'Values the agent may use, such as names, references or dates. It never invents a missing one.' },
					{ displayName: 'Files (Binary Properties)', name: 'files', type: 'string', default: '', placeholder: 'data, attachment_0', description: 'Comma-separated binary properties of the input item to give the agent: it reads them (a screenshot, a photo, a scan, a PDF) to type the values they hold, and uploads them when the site asks for a file' },
					{ displayName: 'Locale', name: 'locale', type: 'string', default: '', placeholder: 'fr-FR', description: 'Language and region of the browser' },
					{ displayName: 'Max Price (Cents)', name: 'max_price_cents', type: 'number', typeOptions: { minValue: 0 }, default: 0, description: 'Stop rather than spend more than this; 0 means no limit' },
					{ displayName: 'Max Seconds', name: 'max_seconds', type: 'number', typeOptions: { minValue: 30, maxValue: 1800 }, default: 600 },
					{ displayName: 'Output Schema (JSON)', name: 'output', type: 'json', default: '', description: 'A JSON Schema the result must follow, in result.data. A task whose answer cannot follow it is not billed.' },
					{ displayName: 'Residential Proxy', name: 'proxy', type: 'boolean', default: false, description: 'Whether to go out through an address in the person\'s country, for sites that block data centres' },
					{ displayName: 'Saved Accounts', name: 'accounts', type: 'string', default: '', description: 'Comma-separated names of the vault accounts the agent may sign in with' },
					{ displayName: 'User', name: 'user', type: 'string', default: '', description: 'Your ID for the person the task is done for: they keep their browser, sign-ins, inbox and vault from task to task' },
					{ displayName: 'Webhook URL', name: 'webhook', type: 'string', default: '', description: 'An address that receives the task events' },
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const credentials = await this.getCredentials('haptiApi');
				const base = String(credentials.baseUrl || 'https://api.hapti.dev').replace(/\/+$/, '');
				const call = async (method: IHttpRequestMethods, path: string, body?: IDataObject): Promise<IDataObject> => {
					try {
						return (await this.helpers.httpRequestWithAuthentication.call(this, 'haptiApi', { method, url: `${base}${path}`, body, json: true })) as IDataObject;
					} catch (error) {
						throw new NodeApiError(this.getNode(), error as never, { itemIndex });
					}
				};
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				if (this.getNodeParameter('resource', itemIndex, 'task') === 'monitor') {
					if (operation === 'watch') {
						const o = this.getNodeParameter('monitorOptions', itemIndex, {}) as IDataObject;
						const body: IDataObject = { url: this.getNodeParameter('monitorUrl', itemIndex), goal: this.getNodeParameter('monitorGoal', itemIndex) };
						if (o.cron) body.cron = o.cron;
						else body.every = this.getNodeParameter('every', itemIndex, '1h');
						const output = parseJson(this, o.output, 'Output Schema', itemIndex);
						if (output && Object.keys(output).length) body.output = output;
						for (const f of ['key', 'name', 'timezone', 'user', 'webhook']) if (o[f]) body[f] = o[f];
						if (o.always) body.notify = 'always';
						out.push({ json: await call('POST', '/v1/monitors', body), pairedItem: itemIndex });
					} else if (operation === 'list') {
						for (const m of ((await call('GET', '/v1/monitors')).data as IDataObject[]) ?? []) out.push({ json: m, pairedItem: itemIndex });
					} else {
						const id = encodeURIComponent(String(this.getNodeParameter('monitorId', itemIndex)).trim());
						if (operation === 'latest') out.push({ json: await call('GET', `/v1/monitors/${id}/latest`), pairedItem: itemIndex });
						else if (operation === 'remove') out.push({ json: await call('DELETE', `/v1/monitors/${id}`), pairedItem: itemIndex });
						else for (const c of ((await call('GET', `/v1/monitors/${id}/changes?limit=${Math.min(200, Number(this.getNodeParameter('limit', itemIndex, 50)) || 50)}`)).data as IDataObject[]) ?? []) out.push({ json: c, pairedItem: itemIndex });
					}
					continue;
				}
				let task: IDataObject;
				if (operation === 'run' || operation === 'create') {
					const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
					const body: IDataObject = { url: this.getNodeParameter('url', itemIndex), goal: this.getNodeParameter('goal', itemIndex) };
					const data = parseJson(this, o.data, 'Data', itemIndex);
					if (data && Object.keys(data).length) body.data = data;
					const output = parseJson(this, o.output, 'Output Schema', itemIndex);
					if (output && Object.keys(output).length) body.output = output;
					if (o.user) body.user = o.user;
					if (o.accounts) body.accounts = String(o.accounts).split(',').map((a) => a.trim()).filter(Boolean);
					if (o.max_seconds) body.max_seconds = o.max_seconds;
					if (o.max_price_cents) body.max_price_cents = o.max_price_cents;
					if (o.proxy) body.proxy = true;
					if (o.locale) body.locale = o.locale;
					if (o.webhook) body.webhook = o.webhook;
					if (o.files) {
						const files: IDataObject[] = [];
						for (const property of String(o.files).split(',').map((f) => f.trim()).filter(Boolean)) {
							const meta = this.helpers.assertBinaryData(itemIndex, property);
							const content = await this.helpers.getBinaryDataBuffer(itemIndex, property);
							files.push({ name: meta.fileName || `${property}${meta.fileExtension ? `.${meta.fileExtension}` : ''}`, base64: content.toString('base64') });
						}
						if (files.length) body.files = files;
					}
					task = await call('POST', '/v1/tasks', body);
					if (operation === 'run') {
						const until = Date.now() + (this.getNodeParameter('waitMinutes', itemIndex, 15) as number) * 60000;
						while (!FINAL.includes(String(task.status)) && task.status !== 'waiting' && Date.now() < until) {
							await sleep(3000);
							task = await call('GET', `/v1/tasks/${task.id}`);
						}
					}
				} else {
					const id = encodeURIComponent(String(this.getNodeParameter('taskId', itemIndex)).trim());
					if (operation === 'get') task = await call('GET', `/v1/tasks/${id}`);
					else if (operation === 'answer') task = await call('POST', `/v1/tasks/${id}/answer`, { value: this.getNodeParameter('value', itemIndex) });
					else if (operation === 'approve') task = await call('POST', `/v1/tasks/${id}/approve`, { approve: this.getNodeParameter('approve', itemIndex) });
					else task = await call('POST', `/v1/tasks/${id}/cancel`);
				}
				out.push({ json: task, pairedItem: itemIndex });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: itemIndex });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}
		return [out];
	}
}

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
				options: [{ name: 'Task', value: 'task' }],
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
				displayName: 'Website URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://www.example.com',
				description: 'The page where the agent starts',
				displayOptions: { show: { operation: ['run', 'create'] } },
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
				displayOptions: { show: { operation: ['run', 'create'] } },
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'tsk_...',
				displayOptions: { show: { operation: ['get', 'answer', 'approve', 'cancel'] } },
			},
			{
				displayName: 'Answer',
				name: 'value',
				type: 'string',
				default: '',
				required: true,
				description: 'The value the task asked for in pending.text',
				displayOptions: { show: { operation: ['answer'] } },
			},
			{
				displayName: 'Approve',
				name: 'approve',
				type: 'boolean',
				default: true,
				description: 'Whether to let the agent do the step it asked about',
				displayOptions: { show: { operation: ['approve'] } },
			},
			{
				displayName: 'Wait at Most (Minutes)',
				name: 'waitMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 15,
				description: 'How long the node waits for the task to end or to need someone before it returns the task as it is',
				displayOptions: { show: { operation: ['run'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['run', 'create'] } },
				options: [
					{ displayName: 'Data (JSON)', name: 'data', type: 'json', default: '{}', description: 'Values the agent may use, such as names, references or dates. It never invents a missing one.' },
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

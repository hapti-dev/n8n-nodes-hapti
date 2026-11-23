import type { IDataObject, INodeExecutionData, INodeType, INodeTypeDescription, IPollFunctions } from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';

export class HaptiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hapti Trigger',
		name: 'haptiTrigger',
		icon: { light: 'file:hapti.svg', dark: 'file:hapti.dark.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: 'When a website changes',
		description: 'Starts the workflow when a Hapti monitor finds a change on a website: new items, removed items, changed values',
		defaults: { name: 'Hapti Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'haptiApi', required: true }],
		properties: [
			{
				displayName: 'Create the monitor with the Hapti node (Monitor → Watch a Website) or in the console, then give its ID here. The workflow runs once for each change it finds.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Monitor ID',
				name: 'monitorId',
				type: 'string',
				default: '',
				placeholder: 'mon_... (empty: every monitor)',
				description: 'The monitor to follow; leave empty to follow every monitor of the account',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const credentials = await this.getCredentials('haptiApi');
		const base = String(credentials.baseUrl || 'https://api.hapti.dev').replace(/\/+$/, '');
		const call = async (path: string): Promise<IDataObject> => {
			try {
				return (await this.helpers.httpRequestWithAuthentication.call(this, 'haptiApi', { method: 'GET', url: `${base}${path}`, json: true })) as IDataObject;
			} catch (error) {
				throw new NodeApiError(this.getNode(), error as never);
			}
		};
		const state = this.getWorkflowStaticData('node');
		const manual = this.getMode() === 'manual';
		const wanted = String(this.getNodeParameter('monitorId', '') ?? '').trim();
		const monitors = wanted ? [await call(`/v1/monitors/${encodeURIComponent(wanted)}`)] : (((await call('/v1/monitors')).data as IDataObject[]) ?? []);
		const since = typeof state.since === 'string' ? state.since : null;
		const seen = new Set(Array.isArray(state.seen) ? (state.seen as string[]) : []);
		const found: IDataObject[] = [];
		for (const m of monitors) {
			const changes = ((await call(`/v1/monitors/${m.id}/changes?limit=${manual ? 1 : 50}`)).data as IDataObject[]) ?? [];
			for (const c of changes) {
				if (!manual && since && (String(c.at) < since || (String(c.at) === since && seen.has(String(c.id))))) continue;
				if (!manual && !since) continue;
				found.push({ monitor: m.id, name: m.name ?? null, url: (m.task as IDataObject | undefined)?.url ?? null, ...c });
			}
		}
		if (!since && !manual) {
			state.since = new Date().toISOString();
			state.seen = [];
			return null;
		}
		if (!found.length) return null;
		found.sort((a, b) => String(a.at).localeCompare(String(b.at)));
		if (!manual) {
			const last = String(found[found.length - 1].at);
			state.since = last;
			state.seen = found.filter((c) => String(c.at) === last).map((c) => String(c.id)).concat(last === since ? [...seen] : []);
		}
		return [this.helpers.returnJsonArray(manual ? found.slice(-1) : found)];
	}
}

import * as api from "./base";

export interface StackService {
	name: string;
	state: string;
	/** Declared in compose (`ports`/`expose`), falling back to the image's exposed ports. */
	ports: number[];
	/** Aliases the user declared for the comphost network in their compose file. */
	aliases: string[];
	/** The alias CompHost will proxy to (declared one if any, else <stack>-<service>). */
	suggestedAlias?: string;
}

/** GET /api/stacks/:id/services — services with state + declared ports. */
export async function getStackServices(id: number): Promise<StackService[]> {
	return await api.get({ url: `/stacks/${id}/services` });
}

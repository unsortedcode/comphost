import * as api from "./base";
import type { DriftFinding } from "./getDomains";

export interface StackDrift {
	findings: DriftFinding[];
	/** null until the first scan after startup */
	checkedOn: string | null;
}

/** GET /api/stacks/:id/drift — what the drift watch found for this stack. */
export async function getStackDrift(id: number): Promise<StackDrift> {
	return await api.get({ url: `/stacks/${id}/drift` });
}

/** POST /api/stacks/:id/drift/accept — take the compose file as it is now as the baseline. */
export async function acceptStackDrift(id: number): Promise<StackDrift> {
	return await api.post({ url: `/stacks/${id}/drift/accept` });
}

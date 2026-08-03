import * as api from "./base";
import type { Stack } from "./models";

export type StackAction = "deploy" | "down" | "stop" | "restart" | "update";

export interface StackActionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	stack: Stack;
}

/**
 * Run a compose lifecycle action against a stack.
 * POST /api/stacks/:id/{deploy|down|stop|restart|update}
 */
export async function stackAction(id: number, action: StackAction): Promise<StackActionResult> {
	return await api.post({
		url: `/stacks/${id}/${action}`,
	});
}

/** Human label for each lifecycle action (used in the progress modal). */
export const stackActionLabels: Record<StackAction, string> = {
	deploy: "Deploying",
	down: "Stopping & removing",
	stop: "Stopping",
	restart: "Restarting",
	update: "Updating (pull & up)",
};

import * as api from "./base";
import type { Stack } from "./models";

/** A new stack; `envContent` is written as its .env before the compose file is checked. */
export async function createStack(item: Partial<Stack> & { envContent?: string }): Promise<Stack> {
	return await api.post({
		url: "/stacks",
		data: {
			name: item.name,
			composeContent: item.composeContent,
			composeFileName: item.composeFileName,
			envContent: item.envContent,
		},
	});
}

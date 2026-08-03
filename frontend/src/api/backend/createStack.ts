import * as api from "./base";
import type { Stack } from "./models";

export async function createStack(item: Partial<Stack>): Promise<Stack> {
	return await api.post({
		url: "/stacks",
		data: {
			name: item.name,
			composeContent: item.composeContent,
			composeFileName: item.composeFileName,
		},
	});
}

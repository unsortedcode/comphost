import * as api from "./base";
import type { Stack } from "./models";

export async function updateStack(item: Partial<Stack>): Promise<Stack> {
	return await api.put({
		url: `/stacks/${item.id}`,
		data: {
			composeContent: item.composeContent,
			composeFileName: item.composeFileName,
		},
	});
}

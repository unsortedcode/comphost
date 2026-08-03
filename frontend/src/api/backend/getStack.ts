import * as api from "./base";
import type { StackExpansion } from "./expansions";
import type { Stack } from "./models";

export async function getStack(id: number, expand?: StackExpansion[], params = {}): Promise<Stack> {
	return await api.get({
		url: `/stacks/${id}`,
		params: {
			expand: expand?.join(","),
			...params,
		},
	});
}

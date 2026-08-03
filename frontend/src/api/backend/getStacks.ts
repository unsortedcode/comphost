import * as api from "./base";
import type { StackExpansion } from "./expansions";
import type { Stack } from "./models";

export async function getStacks(expand?: StackExpansion[], params = {}): Promise<Stack[]> {
	return await api.get({
		url: "/stacks",
		params: {
			expand: expand?.join(","),
			...params,
		},
	});
}

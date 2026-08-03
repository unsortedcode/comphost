import * as api from "./base";

export async function deleteStack(id: number): Promise<boolean> {
	return await api.del({
		url: `/stacks/${id}`,
	});
}

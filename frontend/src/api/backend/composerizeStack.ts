import * as api from "./base";

/** Convert a `docker run ...` command into compose YAML. */
export async function composerizeStack(command: string): Promise<string> {
	const res = await api.post({ url: "/stacks/composerize", data: { command } });
	return (res as { compose: string }).compose;
}

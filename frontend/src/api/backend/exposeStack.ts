// Writes need the CSRF token echoed back from its readable cookie; the
// session itself rides along in the HttpOnly cookie.
const csrfHeader = (): Record<string, string> => {
	const m = document.cookie.match(/(?:^|; )comphost_csrf=([^;]*)/);
	return m ? { "X-CSRF-Token": decodeURIComponent(m[1]) } : {};
};

import * as api from "./base";
import type { ProxyHost } from "./models";

export interface ExposeStackInput {
	service: string;
	port: number;
	domainNames: string[];
	forwardScheme?: string;
	sslForced?: boolean;
	/** "new" requests a Let's Encrypt cert; a number uses an existing cert. */
	certificate?: "new" | number;
	certificateId?: number;
	/** Point DNS at this server via Cloudflare (requires a configured token). */
	cloudflare?: boolean;
	/** Inline HTTP basic auth. */
	basicAuth?: { username: string; password: string };
	accessListId?: number;
}

/** Expose a stack service as a proxy host. POST /api/stacks/:id/expose */
export async function exposeStack(id: number, input: ExposeStackInput): Promise<ProxyHost> {
	return await api.post({
		url: `/stacks/${id}/expose`,
		data: input,
	});
}

/**
 * Streaming variant: reports step progress (cert issuance can take 30s+) via
 * onProgress, resolving when the expose completes. Rejects with the server's
 * message on failure.
 */
export async function exposeStackStreaming(
	id: number,
	input: ExposeStackInput,
	onProgress: (line: string) => void,
): Promise<void> {
	const res = await fetch(`/api/stacks/${id}/expose/stream`, {
		method: "POST",
		headers: { ...csrfHeader(), "Content-Type": "application/json" },
		// The streaming endpoint takes the same snake_case body the API expects.
		body: JSON.stringify({
			service: input.service,
			port: input.port,
			domain_names: input.domainNames,
			forward_scheme: input.forwardScheme,
			ssl_forced: input.sslForced,
			certificate: input.certificate,
			certificate_id: input.certificateId,
			cloudflare: input.cloudflare,
			access_list_id: input.accessListId,
			basic_auth: input.basicAuth,
		}),
	});
	if (!res.ok || !res.body) {
		throw new Error(`Failed to start (HTTP ${res.status})`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let failure: string | null = null;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.startsWith("event: ")) {
				event = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				const payload = line.slice(6);
				if (event === "error") {
					try {
						failure = JSON.parse(payload).message;
					} catch {
						failure = payload;
					}
					event = "";
				} else if (event === "done") {
					event = "";
				} else if (payload.trim()) {
					onProgress(payload);
				}
			}
		}
	}
	if (failure) {
		throw new Error(failure);
	}
}

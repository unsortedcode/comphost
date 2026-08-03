import * as api from "./base";

export interface CloudflareConfig {
	configured: boolean;
	email: string;
	proxied: boolean;
	publicIp: string;
}

/** GET /api/comphost/cloudflare — masked config (no token). */
export async function getCloudflare(): Promise<CloudflareConfig> {
	return await api.get({ url: "/comphost/cloudflare" });
}

/** POST /api/comphost/cloudflare — set token / options. Empty apiToken keeps existing. */
export async function setCloudflare(input: {
	apiToken?: string;
	email?: string;
	proxied?: boolean;
	publicIp?: string;
}): Promise<CloudflareConfig> {
	return await api.post({ url: "/comphost/cloudflare", data: input });
}

/** Download the config backup zip. */
export async function downloadConfigBackup(): Promise<void> {
	await api.download({ url: "/comphost/backup/config" }, "comphost-config-backup.zip");
}

export interface BackupTarget {
	id: number;
	name: string;
	type: "s3" | "ssh";
	config: Record<string, any>;
	enabled: boolean;
	scheduleHours: number;
	lastRun?: string | null;
}

export async function getBackupTargets(): Promise<BackupTarget[]> {
	return await api.get({ url: "/comphost/backup/targets" });
}

export async function createBackupTarget(data: Partial<BackupTarget>): Promise<BackupTarget> {
	return await api.post({ url: "/comphost/backup/targets", data });
}

export async function updateBackupTarget(id: number, data: Partial<BackupTarget>): Promise<BackupTarget> {
	return await api.put({ url: `/comphost/backup/targets/${id}`, data });
}

export async function deleteBackupTarget(id: number): Promise<boolean> {
	return await api.del({ url: `/comphost/backup/targets/${id}` });
}

/** Run an on-demand volume backup of a stack to a target. */
export async function backupStack(stackId: number, targetId: number): Promise<{ volumes: string[]; bytes: number }> {
	return await api.post({ url: `/stacks/${stackId}/backup`, data: { targetId } });
}

export interface RegistryCredential {
	id: number;
	name: string;
	registry: string;
	username: string;
	secret: string;
}

export async function getRegistries(): Promise<RegistryCredential[]> {
	return await api.get({ url: "/comphost/registries" });
}

/** Create (and validate via `docker login`) a private-registry credential. */
export async function createRegistry(data: {
	name: string;
	registry: string;
	username: string;
	secret: string;
}): Promise<RegistryCredential> {
	return await api.post({ url: "/comphost/registries", data });
}

export async function deleteRegistry(id: number): Promise<boolean> {
	return await api.del({ url: `/comphost/registries/${id}` });
}

export interface MountBackupConfig {
	kind: "volume" | "bind";
	source: string;
	destination: string | null;
	readable: boolean;
	targetId: number;
	method: "tar" | "rsync";
	enabled: boolean;
	/** rsync needs a path CompHost can read; otherwise it falls back to tar. */
	rsyncAvailable: boolean;
}

/** Per-mount backup config for a stack (volumes + bind mounts). */
export async function getStackMounts(stackId: number): Promise<MountBackupConfig[]> {
	return await api.get({ url: `/stacks/${stackId}/mounts` });
}

export async function setStackMounts(
	stackId: number,
	mounts: Array<Pick<MountBackupConfig, "kind" | "source" | "method" | "enabled"> & { targetId: number }>,
): Promise<MountBackupConfig[]> {
	return await api.put({ url: `/stacks/${stackId}/mounts`, data: { mounts } });
}

/** Verify a backup target actually works. */
export async function testBackupTarget(id: number): Promise<{ ok: boolean; message: string }> {
	return await api.post({ url: `/comphost/backup/targets/${id}/test` });
}

export interface ServiceUpdate {
	service: string;
	image: string | null;
	local?: string | null;
	remote?: string | null;
	updateAvailable: boolean;
	error?: string;
}

/** Per-service image update check for a stack. */
export async function getStackUpdates(stackId: number): Promise<{ updates: ServiceUpdate[]; updateCount: number }> {
	return await api.get({ url: `/stacks/${stackId}/updates` });
}

export interface DiscoveredStack {
	name: string;
	status: string;
	composeDir: string;
	composeFile: string;
	inStacksDir: boolean;
	readable: boolean;
}

/** Compose projects on this host that CompHost doesn't manage yet. */
export async function discoverStacks(): Promise<DiscoveredStack[]> {
	return await api.get({ url: "/stacks/discover" });
}

/** Adopt an existing compose project in place (no files are moved). */
export async function adoptStack(name: string, composeDir?: string): Promise<unknown> {
	return await api.post({ url: "/stacks/adopt", data: { name, composeDir } });
}

export interface BrowseEntry {
	name: string;
	path: string;
	/** Basename of the compose file found here, or "" if none. */
	composeFile: string;
	/** Already registered as a CompHost stack. */
	managed: boolean;
}

export interface BrowseResult {
	path: string;
	/** null at the filesystem root. */
	parent: string | null;
	stacksDir: string;
	composeFile: string;
	managed: boolean;
	entries: BrowseEntry[];
	truncated: boolean;
}

/**
 * List directories CompHost can see, for locating a compose project that isn't
 * running (and so never shows up in discovery). Defaults to the stacks dir.
 */
export async function browseStackDirs(path?: string): Promise<BrowseResult> {
	return await api.get({ url: "/stacks/browse", params: path ? { path } : undefined });
}

export interface StackEnvVariable {
	name: string;
	value: string;
	/** Referenced by the compose file (as opposed to only present in .env). */
	usedInCompose: boolean;
	defaultValue: string;
	/** Compose wants it but .env doesn't define it. */
	missing: boolean;
}

export async function getStackEnv(stackId: number): Promise<{ content: string; variables: StackEnvVariable[] }> {
	return await api.get({ url: `/stacks/${stackId}/env` });
}

export async function setStackEnv(
	stackId: number,
	data: { content?: string; variables?: Array<{ name: string; value: string }> },
): Promise<{ content: string; variables: StackEnvVariable[] }> {
	return await api.put({ url: `/stacks/${stackId}/env`, data });
}

/** Expose a service as a TCP/UDP stream host. */
export async function exposeStackStream(
	stackId: number,
	input: { service: string; port: number; incomingPort: number; tcp?: boolean; udp?: boolean },
): Promise<unknown> {
	return await api.post({ url: `/stacks/${stackId}/expose-stream`, data: input });
}

/**
 * Services excluded from a stack's status — one-shot init/migration containers
 * that exit 0 by design and would otherwise leave the stack reading Partial.
 */
export async function setStackIgnoredServices(stackId: number, services: string[]): Promise<unknown> {
	return await api.put({ url: `/stacks/${stackId}/ignored-services`, data: { services } });
}

export interface CloudflareDomainCheck {
	domain: string;
	zone: string | null;
	/** Falls inside a zone this token can see. */
	inZone: boolean;
	exists: boolean;
	type: string | null;
	content: string | null;
	proxied: boolean | null;
	/** An A record already pointing at this server. */
	pointsHere: boolean;
	error?: string;
}

/** Read-only: what Cloudflare currently holds for these domains. */
export async function checkCloudflareDomains(
	domains: string[],
): Promise<{ configured: boolean; serverIp: string | null; domains: CloudflareDomainCheck[] }> {
	return await api.post({ url: "/comphost/cloudflare/check", data: { domains } });
}

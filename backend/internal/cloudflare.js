import { waitForPropagation } from "../lib/dns.js";
import errs from "../lib/error.js";
import { ssl as logger } from "../logger.js";
import internalComphostSetting from "./comphost-setting.js";

// Overridable so the DNS paths can be exercised against a stub API in tests.
const CF_API = process.env.CLOUDFLARE_API_URL || "https://api.cloudflare.com/client/v4";
const SETTING_KEY = "cloudflare";

/**
 * Auth headers for either credential type:
 *  - API Token (recommended): Bearer auth.
 *  - Global API Key (legacy): X-Auth-Email + X-Auth-Key. Global keys CANNOT be
 *    used as a Bearer token — Cloudflare rejects them with "Invalid format for
 *    Authorization header", which is the usual cause of a bogus "invalid key".
 * @param   {{apiToken: string, email?: string}} creds
 * @returns {Object}
 */
const authHeaders = (creds) =>
	creds.email
		? { "X-Auth-Email": creds.email, "X-Auth-Key": creds.apiToken }
		: { Authorization: `Bearer ${creds.apiToken}` };

/**
 * Authenticated Cloudflare API call. Throws on API-level failure, surfacing
 * Cloudflare's `error_chain` (where the actionable detail actually lives).
 * @param   {{apiToken: string, email?: string}} creds
 * @param   {string} path
 * @param   {Object} [opts]
 * @returns {Promise<any>}
 */
const cfFetch = async (creds, path, opts = {}) => {
	let res;
	try {
		res = await fetch(`${CF_API}${path}`, {
			...opts,
			headers: { "Content-Type": "application/json", ...authHeaders(creds), ...(opts.headers || {}) },
		});
	} catch (err) {
		throw new errs.ValidationError(`Could not reach the Cloudflare API: ${err.message}`);
	}
	let body;
	try {
		body = await res.json();
	} catch {
		throw new errs.ValidationError(`Cloudflare API error (HTTP ${res.status})`);
	}
	if (!body.success) {
		// Flatten errors + their error_chain; CF puts the useful part in the chain.
		const parts = [];
		for (const e of body.errors || []) {
			parts.push(e.message);
			for (const c of e.error_chain || []) {
				parts.push(c.message);
			}
		}
		let msg = parts.join(" — ") || `HTTP ${res.status}`;
		// Turn the most common (and most confusing) failure into a real instruction.
		if (parts.some((p) => /Authorization header|Invalid API Token|Unable to authenticate/i.test(p))) {
			msg += creds.email
				? ". Check the account email and that this is your Global API Key."
				: ". If you pasted a Global API Key, also fill in the account email field — Global keys can't be used as API tokens. Otherwise create a scoped API Token (My Profile → API Tokens) with Zone:DNS:Edit + Zone:Read.";
		}
		throw new errs.ValidationError(`Cloudflare: ${msg}`);
	}
	return body.result;
};

/**
 * Best-effort detection of this server's public IPv4 (for A records).
 * @returns {Promise<string|null>}
 */
const detectPublicIp = async () => {
	for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			const ip = (await res.text()).trim();
			if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
				return ip;
			}
		} catch {
			// try next
		}
	}
	return null;
};

const internalCloudflare = {
	/**
	 * Store + validate the config: { apiToken, email?, proxied?, publicIp? }.
	 * email is only needed for a legacy Global API Key; publicIp is auto-detected
	 * when blank.
	 * @param {Object} data
	 */
	setConfig: async (data) => {
		const current = (await internalComphostSetting.getRaw(SETTING_KEY)) || {};
		// Trim: pasted tokens routinely carry whitespace/newlines, which Cloudflare
		// rejects as "Invalid format for Authorization header".
		const trim = (v) => (typeof v === "string" ? v.trim() : v);
		const next = {
			apiToken: data.apiToken !== undefined ? trim(data.apiToken) : current.apiToken,
			email: data.email !== undefined ? trim(data.email) : (current.email ?? ""),
			proxied: data.proxied !== undefined ? !!data.proxied : (current.proxied ?? false),
			publicIp: data.publicIp !== undefined ? trim(data.publicIp) : (current.publicIp ?? ""),
		};
		if (!next.apiToken) {
			throw new errs.ValidationError("An API token (or Global API Key) is required");
		}
		// Don't make the user declare which credential type they pasted — just try
		// both. Filling in an email alongside a scoped API Token would otherwise
		// force the Global-key path and fail with "Invalid format for X-Auth-Key".
		const verified = await internalCloudflare.verify(next);
		await internalComphostSetting.setRaw(SETTING_KEY, verified);
		return internalCloudflare.getConfigMasked();
	},

	/**
	 * Prove a credential works, trying whichever auth style fits.
	 *  - API Token  → Bearer, checked against /user/tokens/verify
	 *  - Global Key → X-Auth-Email + X-Auth-Key, checked by listing zones
	 * Returns the credential shape that actually authenticated (email cleared if
	 * it turned out to be a token), so later calls use the right headers.
	 * @param   {Object} creds
	 * @returns {Promise<Object>}
	 */
	verify: async (creds) => {
		const attempts = [];
		if (creds.email) {
			attempts.push({ ...creds }); // Global API Key
		}
		attempts.push({ ...creds, email: "" }); // scoped API Token

		let lastError;
		for (const attempt of attempts) {
			try {
				await cfFetch(attempt, attempt.email ? "/zones?per_page=1" : "/user/tokens/verify");
				return attempt;
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError;
	},

	/** Raw config incl. token — internal only. */
	getConfig: async () => (await internalComphostSetting.getRaw(SETTING_KEY)) || {},

	/** Config for the API — token replaced with a boolean. */
	getConfigMasked: async () => {
		const c = await internalCloudflare.getConfig();
		return {
			configured: !!c.apiToken,
			email: c.email || "",
			proxied: !!c.proxied,
			publicIp: c.publicIp || "",
		};
	},

	/** Whether Cloudflare is set up. */
	isConfigured: async () => {
		const c = await internalCloudflare.getConfig();
		return !!c.apiToken;
	},

	/**
	 * Find the Cloudflare zone that owns a domain (longest matching zone name).
	 * @param   {Object} creds
	 * @param   {string} domain
	 * @returns {Promise<{id: string, name: string}>}
	 */
	findZone: async (creds, domain) => {
		const zones = await cfFetch(creds, "/zones?per_page=50");
		const match = zones
			.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
			.sort((a, b) => b.name.length - a.name.length)[0];
		if (!match) {
			throw new errs.ValidationError(`No Cloudflare zone found for ${domain}`);
		}
		return { id: match.id, name: match.name };
	},

	/**
	 * Inspect what Cloudflare currently has for each domain, without changing
	 * anything. Drives the pre-save warning: a record that already exists but
	 * points somewhere else will fail the HTTP-01 challenge, and silently
	 * repointing someone's live A record is not ours to do.
	 *
	 * Never throws for a single bad domain — each result carries its own status
	 * so one unmanaged domain doesn't blank the whole check.
	 *
	 * @param   {string[]} domains
	 * @returns {Promise<{configured: boolean, serverIp: string|null, domains: Array<Object>}>}
	 */
	checkDomains: async (domains) => {
		const cfg = await internalCloudflare.getConfig();
		if (!cfg.apiToken) {
			return { configured: false, serverIp: null, domains: [] };
		}
		const serverIp = cfg.publicIp || (await detectPublicIp());

		const results = [];
		for (const domain of domains || []) {
			const name = String(domain || "").trim();
			if (!name || name.startsWith("*.")) {
				continue; // wildcards need a DNS challenge, not an A record
			}
			try {
				const zone = await internalCloudflare.findZone(cfg, name);
				const existing = await cfFetch(
					cfg,
					`/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}`,
				);
				const record = existing.find((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
				results.push({
					domain: name,
					zone: zone.name,
					inZone: true,
					exists: !!record,
					type: record?.type ?? null,
					content: record?.content ?? null,
					proxied: record?.proxied ?? null,
					pointsHere: !!record && record.type === "A" && !!serverIp && record.content === serverIp,
				});
			} catch (err) {
				// No zone for this domain (or the API rejected us) — report, don't fail.
				results.push({
					domain: name,
					zone: null,
					inZone: false,
					exists: false,
					type: null,
					content: null,
					proxied: null,
					pointsHere: false,
					error: err.message,
				});
			}
		}
		return { configured: true, serverIp, domains: results };
	},

	/**
	 * Create the A record for any of `domains` that Cloudflare doesn't have yet.
	 * Existing records are left alone — see checkDomains for why.
	 *
	 * @param   {string[]} domains
	 * @param   {Object}   [opts]
	 * @param   {boolean}  [opts.proxied]  override the configured proxy setting
	 * @returns {Promise<{created: string[], skipped: string[], failed: Array<Object>}>}
	 */
	ensureDomains: async (domains, opts = {}) => {
		const status = await internalCloudflare.checkDomains(domains);
		if (!status.configured) {
			throw new errs.ValidationError("Cloudflare is not configured");
		}
		const created = [];
		const skipped = [];
		const failed = [];
		for (const entry of status.domains) {
			if (entry.exists) {
				skipped.push(entry.domain);
				continue;
			}
			if (!entry.inZone) {
				failed.push({ domain: entry.domain, error: entry.error || "No Cloudflare zone for this domain" });
				continue;
			}
			try {
				await internalCloudflare.pointDomain(entry.domain, opts);
				created.push(entry.domain);
			} catch (err) {
				failed.push({ domain: entry.domain, error: err.message });
			}
		}
		return { created, skipped, failed };
	},

	/**
	 * DNS step for host creation. No-op unless the user ticked the box.
	 *
	 * Consumes and removes `data.cloudflare` so it never reaches the insert, and
	 * runs before the certificate is requested — an HTTP-01 challenge against a
	 * domain with no A record cannot succeed.
	 *
	 * @param   {Object}  data               host payload (mutated: cloudflare removed)
	 * @param   {boolean} createCertificate  a new LE cert is being requested now
	 * @returns {Promise<Object|null>}
	 */
	ensureForHost: async (data, createCertificate) => {
		const wanted = !!data.cloudflare;
		// biome-ignore lint/performance/noDelete: must not reach the model insert
		delete data.cloudflare;
		if (!wanted) {
			return null;
		}
		// A proxied (orange-cloud) record makes Cloudflare answer the ACME
		// challenge instead of us, so create it grey while an HTTP-01 cert is
		// being issued. DNS-01 doesn't care.
		const dnsChallenge = !!data.meta?.dns_challenge;
		const opts = createCertificate && !dnsChallenge ? { proxied: false } : {};

		const result = await internalCloudflare.ensureDomains(data.domain_names, opts);
		if (result.failed.length) {
			throw new errs.ValidationError(
				`Could not create Cloudflare DNS record: ${result.failed
					.map((f) => `${f.domain} (${f.error})`)
					.join(", ")}`,
			);
		}

		// Records propagate in seconds, but the certificate request is milliseconds
		// away — and if the CA's first lookup misses, that NXDOMAIN is cached on
		// their side and the retry fails too. So wait for the names to actually be
		// answerable before letting the caller continue.
		if (result.created.length && createCertificate) {
			const timeoutMs = Number(process.env.COMPHOST_DNS_WAIT_MS || 120000);
			const wait = await waitForPropagation(result.created, { timeoutMs });
			result.propagation = wait;
			if (wait.pending.length) {
				throw new errs.ValidationError(
					`Created the DNS record for ${wait.pending.join(", ")}, but it is not answering yet after ${Math.round(
						wait.waitedMs / 1000,
					)}s. The record is in place — wait a minute and request the certificate again.`,
				);
			}
			logger.info(`DNS propagated for ${result.created.join(", ")} in ${Math.round(wait.waitedMs / 1000)}s`);
		}
		return result;
	},

	/**
	 * Ensure an A record for `domain` points at this server (create or update).
	 * @param   {string} domain
	 * @param   {Object} [opts]
	 * @param   {boolean} [opts.proxied]  override the configured proxy setting
	 * @returns {Promise<{name: string, content: string, zone: string}>}
	 */
	pointDomain: async (domain, opts = {}) => {
		const cfg = await internalCloudflare.getConfig();
		if (!cfg.apiToken) {
			throw new errs.ValidationError("Cloudflare is not configured");
		}
		const ip = cfg.publicIp || (await detectPublicIp());
		if (!ip) {
			throw new errs.ValidationError("Could not determine this server's public IP for the DNS record");
		}
		const zone = await internalCloudflare.findZone(cfg, domain);
		const existing = await cfFetch(cfg, `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(domain)}`);
		const proxied = typeof opts.proxied === "boolean" ? opts.proxied : !!cfg.proxied;
		const record = { type: "A", name: domain, content: ip, ttl: 1, proxied };
		if (existing.length) {
			await cfFetch(cfg, `/zones/${zone.id}/dns_records/${existing[0].id}`, {
				method: "PUT",
				body: JSON.stringify(record),
			});
		} else {
			await cfFetch(cfg, `/zones/${zone.id}/dns_records`, {
				method: "POST",
				body: JSON.stringify(record),
			});
		}
		return { name: domain, content: ip, zone: zone.name };
	},
};

export default internalCloudflare;

import { Resolver } from "node:dns";
import dns from "node:dns/promises";

/**
 * DNS helpers for the certificate flow.
 *
 * Everything here queries the zone's *authoritative* nameservers rather than the
 * local resolver. That matters twice over for a record we just created:
 *
 *  - the local resolver may still be inside the negative-cache TTL from an
 *    earlier lookup of the same name (Cloudflare zones typically publish a
 *    300s SOA minimum, so "it doesn't exist" can stick around for five minutes
 *    after the record is live), and
 *  - the authoritative servers are the first place the record actually appears,
 *    so they give the earliest honest answer about propagation.
 */

/** Find the closest ancestor of `fqdn` that has NS records, and return their IPs. */
const authoritativeServers = async (fqdn) => {
	const labels = fqdn.split(".").filter(Boolean);
	// app.foo.example.com -> foo.example.com -> example.com -> com
	for (let i = 0; i < labels.length - 1; i++) {
		const zone = labels.slice(i).join(".");
		let hosts;
		try {
			hosts = await dns.resolveNs(zone);
		} catch {
			continue; // not a delegation point, try the parent
		}
		if (!hosts?.length) {
			continue;
		}
		const ips = (
			await Promise.all(
				hosts.slice(0, 4).map((host) =>
					dns
						.resolve4(host)
						.catch(() => dns.resolve6(host).catch(() => [])),
				),
			)
		).flat();
		if (ips.length) {
			return ips;
		}
	}
	return [];
};

/**
 * Does `fqdn` have an A/AAAA record according to its authoritative nameservers?
 * Returns false rather than throwing — callers treat it as a yes/no signal.
 *
 * @param   {string} fqdn
 * @returns {Promise<boolean>}
 */
export const resolvesAuthoritatively = async (fqdn) => {
	const servers = await authoritativeServers(fqdn);
	if (!servers.length) {
		return false;
	}
	const resolver = new Resolver({ timeout: 3000, tries: 1 });
	resolver.setServers(servers);
	const lookup = (type) =>
		new Promise((resolve) => {
			resolver.resolve(fqdn, type, (err, records) => resolve(!err && !!records?.length));
		});
	return (await lookup("A")) || (await lookup("AAAA"));
};

/**
 * Does `fqdn` resolve at all — locally, or failing that, authoritatively?
 * @param   {string} fqdn
 * @returns {Promise<boolean>}
 */
export const resolvesAnywhere = async (fqdn) => {
	try {
		await dns.resolve4(fqdn);
		return true;
	} catch {
		// fall through
	}
	try {
		await dns.resolve6(fqdn);
		return true;
	} catch {
		// The local resolver may be holding a negative answer from before the
		// record existed, so ask the authoritative servers directly.
		return await resolvesAuthoritatively(fqdn);
	}
};

/**
 * Block until every name is visible on its authoritative nameservers, or the
 * timeout passes. Used after creating DNS records and before asking Let's
 * Encrypt for a certificate: if the CA's first lookup misses, that NXDOMAIN is
 * cached on their side and the retry fails too, so it is worth waiting here.
 *
 * @param   {string[]} names
 * @param   {Object}   [opts]
 * @param   {number}   [opts.timeoutMs=120000]
 * @param   {number}   [opts.intervalMs=3000]
 * @param   {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{resolved: string[], pending: string[], waitedMs: number}>}
 */
export const waitForPropagation = async (names, opts = {}) => {
	const timeoutMs = opts.timeoutMs ?? 120000;
	const intervalMs = opts.intervalMs ?? 3000;
	const started = Date.now();
	const pending = new Set(names.filter(Boolean));
	const resolved = [];

	while (pending.size && Date.now() - started < timeoutMs) {
		for (const name of [...pending]) {
			if (await resolvesAuthoritatively(name)) {
				pending.delete(name);
				resolved.push(name);
				opts.onProgress?.(`${name} is live in DNS`);
			}
		}
		if (!pending.size) {
			break;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	return { resolved, pending: [...pending], waitedMs: Date.now() - started };
};

export default { resolvesAuthoritatively, resolvesAnywhere, waitForPropagation };

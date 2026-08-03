// Single-use, short-lived tickets for authenticating WebSocket connections.
//
// A browser WebSocket cannot set an Authorization header, so the credential has
// to travel in the URL. Putting the session JWT there is a bad trade: query
// strings are recorded in nginx access logs, browser history and Referer
// headers, and this particular credential opens a root shell inside a
// container. Instead the client spends its JWT on a REST call that returns an
// opaque ticket, and the ticket goes in the URL.
//
// A leaked ticket is worth very little: it expires in 30 seconds, works once,
// and is bound to the exact stack, service and user it was minted for.

import crypto from "node:crypto";

const TTL_MS = 30 * 1000;
const tickets = new Map(); // ticket -> { payload, expiresAt }

/**
 * Mint a ticket for a payload.
 * @param   {Object} payload  bound context, e.g. { userId, stackId, service, shell }
 * @returns {{ticket: string, expiresIn: number}}
 */
export const issueTicket = (payload) => {
	const ticket = crypto.randomBytes(32).toString("hex");
	tickets.set(ticket, { payload, expiresAt: Date.now() + TTL_MS });
	return { ticket, expiresIn: Math.floor(TTL_MS / 1000) };
};

/**
 * Redeem a ticket. Returns its payload once, then never again.
 * @param   {string} ticket
 * @returns {Object|null}
 */
export const consumeTicket = (ticket) => {
	if (!ticket) {
		return null;
	}
	const entry = tickets.get(ticket);
	if (!entry) {
		return null;
	}
	tickets.delete(ticket);
	if (entry.expiresAt < Date.now()) {
		return null;
	}
	return entry.payload;
};

// Tickets are normally consumed within seconds; this only reaps the ones whose
// connection never arrived.
const sweeper = setInterval(() => {
	const now = Date.now();
	for (const [ticket, entry] of tickets) {
		if (entry.expiresAt < now) {
			tickets.delete(ticket);
		}
	}
}, TTL_MS).unref?.();

export default { issueTicket, consumeTicket, sweeper };

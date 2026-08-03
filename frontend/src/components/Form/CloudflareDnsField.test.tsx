import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Formik } from "formik";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareDnsField } from "./CloudflareDnsField";

const getCloudflare = vi.fn();
const checkCloudflareDomains = vi.fn();

vi.mock("src/api/backend", () => ({
	getCloudflare: (...a: unknown[]) => getCloudflare(...a),
	checkCloudflareDomains: (...a: unknown[]) => checkCloudflareDomains(...a),
}));

const wrap = (children: ReactNode, domainNames: string[]) => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<Formik initialValues={{ domainNames, cloudflare: false }} onSubmit={() => {}}>
				{children}
			</Formik>
		</QueryClientProvider>,
	);
};

const row = (over: Record<string, unknown>) => ({
	domain: "x.example.com",
	zone: "example.com",
	inZone: true,
	exists: false,
	type: null,
	content: null,
	proxied: null,
	pointsHere: false,
	...over,
});

describe("CloudflareDnsField", () => {
	beforeEach(() => {
		getCloudflare.mockReset();
		checkCloudflareDomains.mockReset();
	});

	// No globals:true in the vitest config, so RTL's auto-cleanup doesn't run and
	// each render would otherwise stack up in the same document.
	afterEach(cleanup);

	it("renders nothing when Cloudflare isn't configured", async () => {
		getCloudflare.mockResolvedValue({ configured: false });
		const { container } = wrap(<CloudflareDnsField />, ["a.example.com"]);
		await waitFor(() => expect(getCloudflare).toHaveBeenCalled());
		expect(container.textContent).toBe("");
		expect(checkCloudflareDomains).not.toHaveBeenCalled();
	});

	it("offers the checkbox and says a record will be created", async () => {
		getCloudflare.mockResolvedValue({ configured: true });
		checkCloudflareDomains.mockResolvedValue({
			configured: true,
			serverIp: "198.51.100.7",
			domains: [row({ domain: "new.example.com" })],
		});
		wrap(<CloudflareDnsField />, ["new.example.com"]);
		expect(await screen.findByRole("checkbox")).toBeTruthy();
		await waitFor(() => expect(document.body.textContent).toContain("No record exists yet"));
		expect(document.body.textContent).toContain("new.example.com");
	});

	it("warns when a record exists but points somewhere else", async () => {
		getCloudflare.mockResolvedValue({ configured: true });
		checkCloudflareDomains.mockResolvedValue({
			configured: true,
			serverIp: "198.51.100.7",
			domains: [row({ domain: "old.example.com", exists: true, type: "A", content: "203.0.113.99" })],
		});
		wrap(<CloudflareDnsField />, ["old.example.com"]);
		await waitFor(() => expect(document.body.textContent).toContain("203.0.113.99"));
		expect(document.body.textContent).toContain("not this server");
	});

	it("warns when the domain is in no visible zone", async () => {
		getCloudflare.mockResolvedValue({ configured: true });
		checkCloudflareDomains.mockResolvedValue({
			configured: true,
			serverIp: "198.51.100.7",
			domains: [row({ domain: "other.tld", inZone: false, zone: null })],
		});
		wrap(<CloudflareDnsField />, ["other.tld"]);
		await waitFor(() => expect(document.body.textContent).toContain("isn't in any Cloudflare zone"));
	});

	it("confirms when the record already points here", async () => {
		getCloudflare.mockResolvedValue({ configured: true });
		checkCloudflareDomains.mockResolvedValue({
			configured: true,
			serverIp: "198.51.100.7",
			domains: [
				row({ domain: "ok.example.com", exists: true, type: "A", content: "198.51.100.7", pointsHere: true }),
			],
		});
		wrap(<CloudflareDnsField />, ["ok.example.com"]);
		await waitFor(() => expect(document.body.textContent).toContain("already points at this server"));
	});

	it("skips wildcards, which need a DNS challenge rather than an A record", async () => {
		getCloudflare.mockResolvedValue({ configured: true });
		checkCloudflareDomains.mockResolvedValue({ configured: true, serverIp: null, domains: [] });
		wrap(<CloudflareDnsField />, ["*.example.com"]);
		await screen.findByRole("checkbox");
		expect(checkCloudflareDomains).not.toHaveBeenCalled();
	});
});

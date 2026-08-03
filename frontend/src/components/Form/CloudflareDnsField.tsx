import { IconAlertTriangle, IconCheck, IconCloud } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Field, useFormikContext } from "formik";
import { useEffect } from "react";
import { checkCloudflareDomains, getCloudflare } from "src/api/backend";
import { T } from "src/locale";

/**
 * "Create the DNS record in Cloudflare" for a host form.
 *
 * Hidden entirely unless Cloudflare is configured. When domains are entered it
 * checks what Cloudflare already holds and warns about the two cases that make a
 * certificate request fail in a way the error message alone doesn't explain:
 * the domain isn't in any zone, or a record exists but points somewhere else.
 */
export function CloudflareDnsField({ name = "cloudflare" }: { name?: string }) {
	const { values, setFieldValue } = useFormikContext<any>();
	const domains: string[] = values?.domainNames ?? [];

	const { data: config } = useQuery({
		queryKey: ["cloudflare-config"],
		queryFn: getCloudflare,
		staleTime: 60 * 1000,
	});

	// Default on once we know Cloudflare is configured: if CompHost holds the
	// credentials, creating the record is the expected behaviour, not an opt-in
	// the user has to discover. Only ever flips the initial false — a deliberate
	// untick isn't overridden, because this runs once per configured load.
	const configured = !!config?.configured;
	useEffect(() => {
		if (configured) {
			setFieldValue(name, true);
		}
	}, [configured, name, setFieldValue]);

	const checkable = domains.filter((d) => d && !d.startsWith("*."));
	const { data: check } = useQuery({
		queryKey: ["cloudflare-check", checkable],
		queryFn: () => checkCloudflareDomains(checkable),
		enabled: !!config?.configured && checkable.length > 0,
		staleTime: 15 * 1000,
	});

	if (!config?.configured) {
		return null;
	}

	const rows = check?.domains ?? [];
	const missing = rows.filter((r) => r.inZone && !r.exists);
	const noZone = rows.filter((r) => !r.inZone);
	const elsewhere = rows.filter((r) => r.exists && !r.pointsHere);
	const good = rows.filter((r) => r.exists && r.pointsHere);

	return (
		<div className="mb-3">
			<label className="form-check">
				<Field type="checkbox" name={name} className="form-check-input" />
				<span className="form-check-label">
					<IconCloud size={16} className="me-1" />
					<T id="cloudflare.create-dns" />
				</span>
			</label>

			{missing.length > 0 && (
				<div className="text-secondary small mt-1">
					<T id="cloudflare.dns-missing" data={{ domains: missing.map((r) => r.domain).join(", ") }} />
				</div>
			)}

			{good.length > 0 && (
				<div className="text-green small mt-1">
					<IconCheck size={13} className="me-1" />
					<T id="cloudflare.dns-ok" data={{ domains: good.map((r) => r.domain).join(", ") }} />
				</div>
			)}

			{elsewhere.map((r) => (
				<div key={r.domain} className="text-warning small mt-1">
					<IconAlertTriangle size={13} className="me-1" />
					<T
						id="cloudflare.dns-elsewhere"
						data={{
							domain: r.domain,
							type: r.type ?? "",
							content: r.content ?? "",
							serverIp: check?.serverIp ?? "",
						}}
					/>
				</div>
			))}

			{noZone.map((r) => (
				<div key={r.domain} className="text-warning small mt-1">
					<IconAlertTriangle size={13} className="me-1" />
					<T id="cloudflare.dns-no-zone" data={{ domain: r.domain }} />
				</div>
			))}
		</div>
	);
}

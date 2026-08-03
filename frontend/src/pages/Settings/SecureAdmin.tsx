import { IconAlertTriangle, IconCheck, IconLock } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Alert } from "react-bootstrap";
import { createCertificate, createProxyHost, testHttpCertificate } from "src/api/backend";
import { Button } from "src/components";
import { useProxyHosts } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

/**
 * Secure the CompHost admin panel itself with a Let's Encrypt certificate:
 * 1. request an LE cert (HTTP-01 via port 80) for the admin domain,
 * 2. create a proxy host forwarding that domain to 127.0.0.1:<admin port> with
 *    SSL forced — nginx proxies to its own admin server block.
 * After that the panel is reachable at https://<domain> and port 81 can be
 * firewalled off.
 */
export default function SecureAdmin() {
	const queryClient = useQueryClient();
	const [domain, setDomain] = useState("");
	const [adminPort, setAdminPort] = useState(81);
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ReactNode | null>(null);
	const [errorMsg, setErrorMsg] = useState<ReactNode | null>(null);
	const [done, setDone] = useState(false);
	const { data: proxyHosts } = useProxyHosts(["certificate"]);

	// Detect an existing self-proxy (any host forwarding to 127.0.0.1).
	const existing = proxyHosts?.find((h) => h.forwardHost === "127.0.0.1" && h.meta?.comphostAdminPanel);

	const handleTest = async () => {
		setTesting(true);
		setErrorMsg(null);
		setTestResult(null);
		try {
			const result = await testHttpCertificate([domain.trim()]);
			const status = result?.[domain.trim()];
			setTestResult(
				status === "ok" ? (
					<span className="text-green">
						<IconCheck size={16} /> <T id="settings.secure-admin.reachable" />
					</span>
				) : (
					<span className="text-warning">
						<IconAlertTriangle size={16} /> <T id={`certificates.http.reachability-${status}`} />
					</span>
				),
			);
		} catch (err: any) {
			setErrorMsg(err.message);
		}
		setTesting(false);
	};

	const handleSecure = async () => {
		const dom = domain.trim();
		if (!dom) {
			setErrorMsg(<T id="settings.secure-admin.domain-required" />);
			return;
		}
		setBusy(true);
		setErrorMsg(null);
		try {
			// 1. Let's Encrypt certificate (HTTP-01 challenge over port 80).
			const cert = await createCertificate({
				domainNames: [dom],
				provider: "letsencrypt",
				meta: { keyType: "ecdsa" },
			} as any);

			// 2. Proxy host: domain -> this container's own admin server block.
			await createProxyHost({
				domainNames: [dom],
				forwardScheme: "http",
				forwardHost: "127.0.0.1",
				forwardPort: adminPort,
				certificateId: cert.id,
				sslForced: true,
				blockExploits: true,
				allowWebsocketUpgrade: true,
				accessListId: 0,
				cachingEnabled: false,
				http2Support: true,
				hstsEnabled: false,
				hstsSubdomains: false,
				advancedConfig: "",
				locations: [],
				meta: { comphostAdminPanel: true },
			} as any);

			queryClient.invalidateQueries({ queryKey: ["proxy-hosts"] });
			queryClient.invalidateQueries({ queryKey: ["certificates"] });
			showObjectSuccess("proxy-host", "saved");
			setDone(true);
		} catch (err: any) {
			setErrorMsg(err.message || "Failed");
		}
		setBusy(false);
	};

	return (
		<div className="card-body">
			<h3 className="mb-3">
				<IconLock size={18} className="me-1" />
				<T id="settings.secure-admin" />
			</h3>
			<Alert variant="danger" show={!!errorMsg} onClose={() => setErrorMsg(null)} dismissible>
				{errorMsg}
			</Alert>

			{existing || done ? (
				<Alert variant="success">
					{/* Tabler styles .alert as a flex row, so the icon, the message and the
					    URL would each become a flex item side by side (the URL sitting a
					    few px lower thanks to its margin). Keep them in one block child. */}
					<div>
						<div className="d-flex align-items-center">
							<IconCheck size={16} className="me-1 flex-shrink-0" />
							<T id="settings.secure-admin.done" />
						</div>
						{existing ? (
							<a
								className="d-inline-block mt-1 text-break"
								href={`https://${existing.domainNames?.[0]}`}
								target="_blank"
								rel="noreferrer"
							>
								https://{existing.domainNames?.[0]}
							</a>
						) : null}
					</div>
				</Alert>
			) : (
				<>
					<p className="text-secondary">
						<T id="settings.secure-admin.help" />
					</p>
					<div className="row">
						<div className="col-8 mb-3">
							<label className="form-label">
								<T id="settings.secure-admin.domain" />
							</label>
							<input
								type="text"
								className="form-control"
								placeholder="comphost.example.com"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
							/>
						</div>
						<div className="col-4 mb-3">
							<label className="form-label">
								<T id="settings.secure-admin.port" />
							</label>
							<input
								type="number"
								min={1}
								max={65535}
								className="form-control"
								value={adminPort}
								onChange={(e) => setAdminPort(Number.parseInt(e.target.value, 10) || 81)}
							/>
						</div>
					</div>
					{testResult && <p>{testResult}</p>}
					<div className="d-flex gap-2">
						<Button onClick={handleTest} isLoading={testing} disabled={testing || !domain.trim()}>
							<T id="settings.secure-admin.test" />
						</Button>
						<Button
							actionType="primary"
							onClick={handleSecure}
							isLoading={busy}
							disabled={busy || !domain.trim()}
						>
							<T id="settings.secure-admin.submit" />
						</Button>
					</div>
					<p className="text-secondary mt-3">
						<IconAlertTriangle size={14} className="me-1" />
						<T id="settings.secure-admin.firewall-hint" />
					</p>
				</>
			)}
		</div>
	);
}

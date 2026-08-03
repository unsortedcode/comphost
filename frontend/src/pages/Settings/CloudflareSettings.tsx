import { IconCheck, IconCloud } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import { type CloudflareConfig, getCloudflare, setCloudflare } from "src/api/backend";
import { Button } from "src/components";
import { T } from "src/locale";

/**
 * Cloudflare API token config. The token lets CompHost create DNS records when
 * exposing stacks ("point DNS via Cloudflare"). The token is never returned by
 * the API — only a `configured` flag.
 */
export default function CloudflareSettings() {
	const [cfg, setCfg] = useState<CloudflareConfig | null>(null);
	const [token, setToken] = useState("");
	const [proxied, setProxied] = useState(false);
	const [email, setEmail] = useState("");
	const [publicIp, setPublicIp] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		getCloudflare()
			.then((c) => {
				setCfg(c);
				setProxied(c.proxied);
				setEmail(c.email || "");
				setPublicIp(c.publicIp);
			})
			.catch((e) => setError(e.message));
	}, []);

	const save = async () => {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const c = await setCloudflare({ apiToken: token || undefined, email, proxied, publicIp });
			setCfg(c);
			setToken("");
			setSaved(true);
		} catch (e: any) {
			setError(e.message || "Failed");
		}
		setBusy(false);
	};

	return (
		<div className="card-body">
			<h3 className="mb-3">
				<IconCloud size={18} className="me-1" />
				<T id="settings.cloudflare" />
			</h3>
			<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
				{error}
			</Alert>
			{saved && (
				<Alert variant="success">
					<IconCheck size={16} className="me-1" />
					<T id="settings.cloudflare.saved" />
				</Alert>
			)}
			<p className="text-secondary">
				<T id="settings.cloudflare.help" />
			</p>

			<div className="mb-3">
				<label className="form-label">
					<T id="settings.cloudflare.token" />
					{cfg?.configured && (
						<span className="badge bg-green text-white ms-2">
							<T id="settings.cloudflare.configured" />
						</span>
					)}
				</label>
				<input
					type="password"
					className="form-control"
					autoComplete="off"
					placeholder={cfg?.configured ? "•••••••• (leave blank to keep)" : "Cloudflare API token"}
					value={token}
					onChange={(e) => setToken(e.target.value)}
				/>
				<small className="form-hint">
					<T id="settings.cloudflare.token-hint" />
				</small>
			</div>

			<div className="mb-3">
				<label className="form-label">
					<T id="settings.cloudflare.email" />
				</label>
				<input
					type="email"
					className="form-control"
					autoComplete="off"
					placeholder="leave blank when using an API Token"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<small className="form-hint">
					<T id="settings.cloudflare.email-hint" />
				</small>
			</div>

			<div className="mb-3">
				<label className="form-label">
					<T id="settings.cloudflare.public-ip" />
				</label>
				<input
					type="text"
					className="form-control"
					placeholder="auto-detect"
					value={publicIp}
					onChange={(e) => setPublicIp(e.target.value)}
				/>
			</div>

			<label className="form-check">
				<input
					className="form-check-input"
					type="checkbox"
					checked={proxied}
					onChange={(e) => setProxied(e.target.checked)}
				/>
				<span className="form-check-label">
					<T id="settings.cloudflare.proxied" />
				</span>
			</label>

			<div className="mt-3">
				<Button actionType="primary" onClick={save} isLoading={busy} disabled={busy}>
					<T id="save" />
				</Button>
			</div>
		</div>
	);
}

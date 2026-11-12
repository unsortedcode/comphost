import { IconEdit, IconMail, IconPlugConnected, IconTrash } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import {
	deleteSmtpRoute,
	deleteSmtpUpstream,
	getSmtpRelay,
	type SmtpRelayConfig,
	type SmtpSecurity,
	saveSmtpRoute,
	saveSmtpUpstream,
	sendSmtpTest,
	setSmtpRelay,
	testSmtpUpstream,
} from "src/api/backend";
import { Button } from "src/components";
import { useLocaleState } from "src/context";
import { formatDateTime, intl, T } from "src/locale";

const EMPTY_UPSTREAM = { name: "", host: "", port: "587", security: "starttls", username: "", password: "" };
interface RouteForm {
	id?: number;
	match: string;
	upstreamId: string;
	rewriteFrom: string;
	keepReplyTo: boolean;
}
const EMPTY_ROUTE: RouteForm = { match: "", upstreamId: "", rewriteFrom: "", keepReplyTo: true };
const DEFAULT_PORT: Record<SmtpSecurity, string> = { none: "25", starttls: "587", tls: "465" };

/**
 * The SMTP relay hosted services reach as smtp:25 on the comphost network.
 * Mail goes to one of the upstream servers below, picked by sender address;
 * a route can rewrite the sender to one that upstream accepts.
 */
export default function SmtpSettings() {
	const { locale } = useLocaleState();
	const [cfg, setCfg] = useState<SmtpRelayConfig | null>(null);
	const [error, setError] = useState<ReactNode | null>(null);
	const [notice, setNotice] = useState<ReactNode | null>(null);
	const [busy, setBusy] = useState(false);
	const [upstream, setUpstream] = useState<Record<string, string> & { id?: string }>(EMPTY_UPSTREAM);
	const [route, setRoute] = useState<RouteForm>(EMPTY_ROUTE);
	const [test, setTest] = useState({ from: "", to: "" });

	const load = useCallback(
		() =>
			getSmtpRelay()
				.then(setCfg)
				.catch((e) => setError(e.message)),
		[],
	);
	useEffect(() => {
		load();
	}, [load]);

	// Every change returns the whole config; show it, or the server's message.
	const run = async (fn: () => Promise<SmtpRelayConfig | undefined>, after?: () => void) => {
		setError(null);
		setNotice(null);
		setBusy(true);
		try {
			const next = await fn();
			if (next) setCfg(next);
			after?.();
		} catch (e: any) {
			setError(e.message);
		}
		setBusy(false);
	};

	if (!cfg) {
		return (
			<div className="card-body">
				{error ? (
					<Alert variant="danger">{error}</Alert>
				) : (
					<span className="spinner-border spinner-border-sm" />
				)}
			</div>
		);
	}

	const upstreamName = (id: number) => cfg.upstreams.find((u) => u.id === id)?.name ?? `#${id}`;
	const saveUpstream = () =>
		run(
			() =>
				saveSmtpUpstream({
					id: upstream.id ? Number(upstream.id) : undefined,
					name: upstream.name,
					host: upstream.host,
					port: Number(upstream.port),
					security: upstream.security as SmtpSecurity,
					username: upstream.username,
					password: upstream.password,
				}),
			() => setUpstream(EMPTY_UPSTREAM),
		);
	const testUpstream = (id: number) =>
		run(async () => {
			const r = await testSmtpUpstream(id);
			if (r.ok) setNotice(<T id="settings.smtp.test-ok" data={{ name: upstreamName(id) }} />);
			else throw new Error(r.error);
		});
	const sendTest = () =>
		run(async () => {
			const r = await sendSmtpTest(test);
			if (!r.ok) throw new Error(r.error);
			setNotice(<T id="settings.smtp.send-ok" data={{ upstream: r.upstream ?? "", from: r.from ?? "" }} />);
			await load();
		});

	const field = (label: string, input: ReactNode, cols = "col-md-6") => (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the `input` nested inside
		<label className={`${cols} mb-2`}>
			<span className="form-label small mb-0 d-block">
				<T id={label} />
			</span>
			{input}
		</label>
	);
	const text = (value: string, onChange: (v: string) => void, extra: object = {}) => (
		<input
			className="form-control form-control-sm"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			{...extra}
		/>
	);

	const s = cfg.status;
	return (
		<div className="card-body">
			<h3 className="mb-3">
				<IconMail size={18} className="me-1" />
				<T id="settings.smtp" />
			</h3>
			<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
				{error}
			</Alert>
			<Alert variant="success" show={!!notice} onClose={() => setNotice(null)} dismissible>
				{notice}
			</Alert>
			<p className="text-secondary">
				<T id="settings.smtp.help" />
			</p>

			<label className="form-check form-switch mb-2">
				<input
					className="form-check-input"
					type="checkbox"
					checked={cfg.enabled}
					disabled={busy}
					onChange={(e) => run(() => setSmtpRelay({ enabled: e.target.checked }))}
				/>
				<span className="form-check-label">
					<T id="settings.smtp.enabled" />
				</span>
			</label>
			{cfg.enabled ? (
				<div className="small mb-4">
					{s.error ? (
						<div className="text-red">{s.error}</div>
					) : (
						<div className={s.listening ? "text-green" : "text-secondary"}>
							<T id={s.listening ? "settings.smtp.listening" : "settings.smtp.not-listening"} />
							{s.subnet ? (
								<span className="text-secondary">
									{" "}
									<T id="settings.smtp.subnet" data={{ subnet: s.subnet }} />
								</span>
							) : null}
						</div>
					)}
					{s.alias === "conflict" ? (
						<div className="text-orange">
							<T id="settings.smtp.alias-conflict" />
						</div>
					) : null}
					{s.alias === "unknown" ? (
						<div className="text-secondary">
							<T id="settings.smtp.alias-unknown" />
						</div>
					) : null}
				</div>
			) : (
				<div className="mb-4" />
			)}

			<h4>
				<T id="settings.smtp.upstreams" />
			</h4>
			{cfg.upstreams.length > 0 && (
				<table className="table table-sm">
					<tbody>
						{cfg.upstreams.map((u) => (
							<tr key={u.id}>
								<td className="fw-medium">{u.name}</td>
								<td>
									{u.host}:{u.port}
								</td>
								<td>
									<T id={`settings.smtp.security.${u.security}`} />
								</td>
								<td className="text-secondary">{u.username || "—"}</td>
								<td className="text-end text-nowrap">
									<Button size="sm" onClick={() => testUpstream(u.id)} disabled={busy}>
										<IconPlugConnected size={14} />
									</Button>
									<Button
										size="sm"
										className="ms-1"
										onClick={() =>
											setUpstream({
												id: String(u.id),
												name: u.name,
												host: u.host,
												port: String(u.port),
												security: u.security,
												username: u.username,
												password: "",
											})
										}
									>
										<IconEdit size={14} />
									</Button>
									<Button
										size="sm"
										className="ms-1"
										onClick={() => run(() => deleteSmtpUpstream(u.id))}
									>
										<IconTrash size={14} />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="card bg-surface-secondary mb-4">
				<div className="card-body">
					<div className="row">
						{field(
							"settings.smtp.name",
							text(upstream.name, (v) => setUpstream({ ...upstream, name: v })),
						)}
						{field(
							"settings.smtp.host",
							text(upstream.host, (v) => setUpstream({ ...upstream, host: v }), {
								placeholder: "smtp.example.com",
							}),
						)}
						{field(
							"settings.smtp.security",
							<select
								className="form-select form-select-sm"
								value={upstream.security}
								onChange={(e) =>
									setUpstream({
										...upstream,
										security: e.target.value,
										port: DEFAULT_PORT[e.target.value as SmtpSecurity],
									})
								}
							>
								{(["starttls", "tls", "none"] as SmtpSecurity[]).map((v) => (
									<option key={v} value={v}>
										{intl.formatMessage({ id: `settings.smtp.security.${v}` })}
									</option>
								))}
							</select>,
							"col-md-4",
						)}
						{field(
							"settings.smtp.port",
							text(upstream.port, (v) => setUpstream({ ...upstream, port: v }), { type: "number" }),
							"col-md-2",
						)}
						{field(
							"settings.smtp.username",
							text(upstream.username, (v) => setUpstream({ ...upstream, username: v }), {
								autoComplete: "off",
							}),
							"col-md-3",
						)}
						{field(
							"settings.smtp.password",
							text(upstream.password, (v) => setUpstream({ ...upstream, password: v }), {
								type: "password",
								autoComplete: "new-password",
								placeholder: upstream.id
									? intl.formatMessage({ id: "settings.smtp.password-keep" })
									: "",
							}),
							"col-md-3",
						)}
					</div>
					<Button actionType="primary" size="sm" onClick={saveUpstream} isLoading={busy} disabled={busy}>
						<T id={upstream.id ? "save" : "settings.smtp.add-upstream"} />
					</Button>
					{upstream.id ? (
						<Button size="sm" className="ms-2" onClick={() => setUpstream(EMPTY_UPSTREAM)}>
							<T id="cancel" />
						</Button>
					) : null}
				</div>
			</div>

			<h4>
				<T id="settings.smtp.routes" />
			</h4>
			<p className="text-secondary small">
				<T id="settings.smtp.routes.help" />
			</p>
			{cfg.routes.length > 0 && (
				<table className="table table-sm">
					<tbody>
						{cfg.routes.map((r) => (
							<tr key={r.id}>
								<td className="fw-medium">{r.match}</td>
								<td>→ {upstreamName(r.upstreamId)}</td>
								<td className="text-secondary">
									{r.rewriteFrom ? (
										<T
											id={
												r.keepReplyTo ? "settings.smtp.rewrites-keep" : "settings.smtp.rewrites"
											}
											data={{ address: r.rewriteFrom }}
										/>
									) : (
										"—"
									)}
								</td>
								<td className="text-end text-nowrap">
									<Button
										size="sm"
										onClick={() => setRoute({ ...r, upstreamId: String(r.upstreamId) })}
									>
										<IconEdit size={14} />
									</Button>
									<Button size="sm" className="ms-1" onClick={() => run(() => deleteSmtpRoute(r.id))}>
										<IconTrash size={14} />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="card bg-surface-secondary mb-4">
				<div className="card-body">
					<div className="row">
						{field(
							"settings.smtp.match",
							text(route.match, (v) => setRoute({ ...route, match: v }), {
								placeholder: "app@example.com, @example.com, *",
							}),
							"col-md-4",
						)}
						{field(
							"settings.smtp.upstream",
							<select
								className="form-select form-select-sm"
								value={route.upstreamId}
								onChange={(e) => setRoute({ ...route, upstreamId: e.target.value })}
							>
								<option value="">—</option>
								{cfg.upstreams.map((u) => (
									<option key={u.id} value={u.id}>
										{u.name}
									</option>
								))}
							</select>,
							"col-md-3",
						)}
						{field(
							"settings.smtp.rewrite-from",
							text(route.rewriteFrom, (v) => setRoute({ ...route, rewriteFrom: v }), {
								placeholder: intl.formatMessage({ id: "settings.smtp.rewrite-from.placeholder" }),
							}),
							"col-md-5",
						)}
					</div>
					{route.rewriteFrom ? (
						<label className="form-check mb-2">
							<input
								className="form-check-input"
								type="checkbox"
								checked={route.keepReplyTo}
								onChange={(e) => setRoute({ ...route, keepReplyTo: e.target.checked })}
							/>
							<span className="form-check-label small">
								<T id="settings.smtp.keep-reply-to" />
							</span>
						</label>
					) : null}
					<Button
						actionType="primary"
						size="sm"
						disabled={busy}
						onClick={() =>
							run(
								() =>
									saveSmtpRoute({
										id: route.id,
										match: route.match,
										upstreamId: Number(route.upstreamId),
										rewriteFrom: route.rewriteFrom,
										keepReplyTo: route.keepReplyTo,
									}),
								() => setRoute(EMPTY_ROUTE),
							)
						}
					>
						<T id={route.id ? "save" : "settings.smtp.add-route"} />
					</Button>
					{route.id ? (
						<Button size="sm" className="ms-2" onClick={() => setRoute(EMPTY_ROUTE)}>
							<T id="cancel" />
						</Button>
					) : null}
				</div>
			</div>

			<h4>
				<T id="settings.smtp.send-test" />
			</h4>
			<div className="row align-items-end mb-4">
				{field(
					"settings.smtp.test-from",
					text(test.from, (v) => setTest({ ...test, from: v }), { placeholder: "app@example.com" }),
					"col-md-5",
				)}
				{field(
					"settings.smtp.test-to",
					text(test.to, (v) => setTest({ ...test, to: v }), { placeholder: "you@example.com" }),
					"col-md-5",
				)}
				<div className="col-md-2 mb-2">
					<Button size="sm" onClick={sendTest} disabled={busy || !test.from || !test.to}>
						<T id="settings.smtp.send" />
					</Button>
				</div>
			</div>

			{cfg.recent.length > 0 && (
				<>
					<h4>
						<T id="settings.smtp.recent" />
					</h4>
					<table className="table table-sm small">
						<tbody>
							{cfg.recent.map((m) => (
								<tr key={`${m.at}-${m.from}`}>
									<td className="text-secondary text-nowrap">{formatDateTime(m.at, locale)}</td>
									<td>{m.from || "<>"}</td>
									<td className={m.ok ? "text-green" : "text-red"}>
										{m.ok ? `→ ${m.upstream} (${m.route})` : m.error}
										{m.test ? (
											<span className="badge bg-secondary-lt ms-1">
												<T id="settings.smtp.test" />
											</span>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</div>
	);
}

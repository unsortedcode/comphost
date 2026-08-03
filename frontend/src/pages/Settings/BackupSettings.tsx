import { IconDownload, IconTrash } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import {
	type BackupTarget,
	createBackupTarget,
	deleteBackupTarget,
	downloadConfigBackup,
	getBackupTargets,
	testBackupTarget,
} from "src/api/backend";
import { Button } from "src/components";
import { T } from "src/locale";

/**
 * Backup settings: one-click config backup download + management of volume-backup
 * targets (S3 via rclone, SSH via rsync) with an optional schedule.
 */
export default function BackupSettings() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);
	const [targets, setTargets] = useState<BackupTarget[]>([]);
	const [type, setType] = useState<"s3" | "ssh">("s3");
	const [form, setForm] = useState<Record<string, string>>({ name: "" });
	const [testing, setTesting] = useState(0);
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

	const load = () => getBackupTargets().then(setTargets).catch((e) => setError(e.message));
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => { load(); }, []);

	const download = async () => {
		setBusy(true);
		setError(null);
		try {
			await downloadConfigBackup();
		} catch (e: any) {
			setError(e.message || "Failed");
		}
		setBusy(false);
	};

	const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

	const addTarget = async () => {
		setError(null);
		const config: Record<string, any> =
			type === "s3"
				? {
						endpoint: form.endpoint,
						region: form.region || "us-east-1",
						bucket: form.bucket,
						path_prefix: form.path_prefix || "",
						access_key_id: form.access_key_id,
						secret_access_key: form.secret_access_key,
					}
				: {
						host: form.host,
						port: Number.parseInt(form.port, 10) || 22,
						user: form.user,
						path: form.path,
						private_key: form.private_key,
					};
		try {
			await createBackupTarget({
				name: form.name,
				type,
				config,
				scheduleCron: form.schedule_cron || "",
			} as any);
			setForm({ name: "" });
			load();
		} catch (e: any) {
			setError(e.message || "Failed to add target");
		}
	};

	const test = async (id: number) => {
		setTesting(id);
		setTestResult(null);
		try {
			setTestResult(await testBackupTarget(id));
		} catch (e: any) {
			setTestResult({ ok: false, message: e.message || "Test failed" });
		}
		setTesting(0);
	};

	const remove = async (id: number) => {
		await deleteBackupTarget(id);
		load();
	};

	const field = (k: string, label: string, opts: { type?: string; placeholder?: string } = {}) => (
		<div className="col-md-6 mb-2">
			<label className="form-label small mb-0">{label}</label>
			<input
				type={opts.type || "text"}
				className="form-control form-control-sm"
				placeholder={opts.placeholder}
				autoComplete="off"
				value={form[k] || ""}
				onChange={(e) => set(k, e.target.value)}
			/>
		</div>
	);

	return (
		<div className="card-body">
			<h3 className="mb-3">
				<T id="settings.backup" />
			</h3>
			<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
				{error}
			</Alert>

			<p className="text-secondary">
				<T id="settings.backup.config-help" />
			</p>
			<Button actionType="primary" onClick={download} isLoading={busy} disabled={busy}>
				<IconDownload size={16} className="me-1" />
				<T id="settings.backup.download-config" />
			</Button>

			<hr className="my-4" />

			<h4>
				<T id="settings.backup.targets" />
			</h4>
			<p className="text-secondary">
				<T id="settings.backup.targets-help" />
			</p>

			{targets.length > 0 && (
				<table className="table table-sm">
					<thead>
						<tr>
							<th>Name</th>
							<th>Type</th>
							<th>Schedule</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{targets.map((t) => (
							<tr key={t.id}>
								<td>{t.name}</td>
								<td>{t.type.toUpperCase()}</td>
								<td>{(t as any).scheduleCron || (t.scheduleHours > 0 ? `every ${t.scheduleHours}h` : "manual")}</td>
								<td className="text-end">
									<Button size="sm" className="me-1" onClick={() => test(t.id)} isLoading={testing === t.id}>
										<T id="settings.backup.test" />
									</Button>
									<Button size="sm" onClick={() => remove(t.id)}>
										<IconTrash size={14} />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{testResult && (
				<Alert variant={testResult.ok ? "success" : "danger"} onClose={() => setTestResult(null)} dismissible>
					{testResult.message}
				</Alert>
			)}

			{targets
				.filter((t) => t.type === "ssh" && (t.config as any)?.public_key)
				.map((t) => (
					<div className="mb-3" key={`pk-${t.id}`}>
						<label className="form-label small mb-1">
							{t.name}: <T id="settings.backup.public-key" />
						</label>
						<textarea
							className="form-control form-control-sm font-monospace"
							rows={2}
							readOnly
							value={(t.config as any).public_key}
							onFocus={(e) => e.currentTarget.select()}
						/>
					</div>
				))}

			<div className="card bg-surface-secondary mt-2">
				<div className="card-body">
					<div className="row">
						<div className="col-md-6 mb-2">
							<label className="form-label small mb-0">Type</label>
							<select
								className="form-select form-select-sm"
								value={type}
								onChange={(e) => setType(e.target.value as "s3" | "ssh")}
							>
								<option value="s3">S3 (rclone)</option>
								<option value="ssh">SSH (rsync)</option>
							</select>
						</div>
						{field("name", "Name", { placeholder: "my-backups" })}
						{type === "s3" ? (
							<>
								{field("endpoint", "Endpoint", { placeholder: "https://s3.amazonaws.com" })}
								{field("region", "Region", { placeholder: "us-east-1" })}
								{field("bucket", "Bucket")}
								{field("path_prefix", "Path prefix", { placeholder: "comphost" })}
								{field("access_key_id", "Access Key ID")}
								{field("secret_access_key", "Secret Access Key", { type: "password" })}
							</>
						) : (
							<>
								{field("host", "Host")}
								{field("port", "Port", { placeholder: "22" })}
								{field("user", "User")}
								{field("path", "Remote path", { placeholder: "/backups" })}
								<div className="col-12 mb-2">
									<label className="form-label small mb-0">Private key (PEM)</label>
									<textarea
										className="form-control form-control-sm"
										rows={3}
										value={form.private_key || ""}
										onChange={(e) => set("private_key", e.target.value)}
									/>
								</div>
							</>
						)}
						{field("schedule_cron", "Schedule (cron) — e.g. 0 3 * * *", { placeholder: "blank = manual only" })}
					</div>
					<Button actionType="primary" size="sm" onClick={addTarget} disabled={!form.name}>
						<T id="settings.backup.add-target" />
					</Button>
				</div>
			</div>
		</div>
	);
}

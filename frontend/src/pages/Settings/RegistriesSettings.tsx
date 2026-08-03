import { IconLogin2, IconTrash } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import { createRegistry, deleteRegistry, getRegistries, type RegistryCredential } from "src/api/backend";
import { Button } from "src/components";
import { T } from "src/locale";

/**
 * Private container-registry logins. Creating one runs `docker login` on the
 * server (validating it) and stores it so `docker compose pull/up` can fetch
 * private images for stacks. Secrets are never returned by the API.
 */
export default function RegistriesSettings() {
	const [rows, setRows] = useState<RegistryCredential[]>([]);
	const [form, setForm] = useState<Record<string, string>>({ name: "", registry: "", username: "", secret: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	const load = () => getRegistries().then(setRows).catch((e) => setError(e.message));
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => { load(); }, []);

	const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

	const add = async () => {
		setError(null);
		if (!form.name || !form.registry || !form.username || !form.secret) {
			setError("All fields are required");
			return;
		}
		setBusy(true);
		try {
			await createRegistry({ name: form.name, registry: form.registry, username: form.username, secret: form.secret });
			setForm({ name: "", registry: "", username: "", secret: "" });
			load();
		} catch (e: any) {
			setError(e.message || "docker login failed — check the registry, username and token");
		}
		setBusy(false);
	};

	const remove = async (id: number) => {
		await deleteRegistry(id);
		load();
	};

	return (
		<div className="card-body">
			<h3 className="mb-3">
				<IconLogin2 size={18} className="me-1" />
				<T id="settings.registries" />
			</h3>
			<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
				{error}
			</Alert>
			<p className="text-secondary">
				<T id="settings.registries.help" />
			</p>

			{rows.length > 0 && (
				<table className="table table-sm">
					<thead>
						<tr>
							<th>Name</th>
							<th>Registry</th>
							<th>Username</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id}>
								<td>{r.name}</td>
								<td>{r.registry}</td>
								<td>{r.username}</td>
								<td className="text-end">
									<Button size="sm" onClick={() => remove(r.id)}>
										<IconTrash size={14} />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<div className="card bg-surface-secondary mt-2">
				<div className="card-body">
					<div className="row">
						<div className="col-md-6 mb-2">
							<label className="form-label small mb-0">Name</label>
							<input
								className="form-control form-control-sm"
								placeholder="my-registry"
								value={form.name}
								onChange={(e) => set("name", e.target.value)}
							/>
						</div>
						<div className="col-md-6 mb-2">
							<label className="form-label small mb-0">Registry host</label>
							<input
								className="form-control form-control-sm"
								placeholder="ghcr.io (or docker.io, registry.example.com)"
								value={form.registry}
								onChange={(e) => set("registry", e.target.value)}
							/>
						</div>
						<div className="col-md-6 mb-2">
							<label className="form-label small mb-0">Username</label>
							<input
								className="form-control form-control-sm"
								autoComplete="off"
								value={form.username}
								onChange={(e) => set("username", e.target.value)}
							/>
						</div>
						<div className="col-md-6 mb-2">
							<label className="form-label small mb-0">Password / token</label>
							<input
								type="password"
								className="form-control form-control-sm"
								autoComplete="new-password"
								value={form.secret}
								onChange={(e) => set("secret", e.target.value)}
							/>
						</div>
					</div>
					<Button actionType="primary" size="sm" onClick={add} isLoading={busy} disabled={busy}>
						<T id="settings.registries.add" />
					</Button>
				</div>
			</div>
		</div>
	);
}

import cn from "classnames";
import { useState } from "react";
import { T } from "src/locale";
import BackupSettings from "./BackupSettings";
import CloudflareSettings from "./CloudflareSettings";
import DefaultSite from "./DefaultSite";
import RegistriesSettings from "./RegistriesSettings";
import SecureAdmin from "./SecureAdmin";

const TABS = [
	{ key: "default-site", label: "settings.default-site", Component: DefaultSite },
	{ key: "secure-admin", label: "settings.secure-admin", Component: SecureAdmin },
	{ key: "cloudflare", label: "settings.cloudflare", Component: CloudflareSettings },
	{ key: "registries", label: "settings.registries", Component: RegistriesSettings },
	{ key: "backup", label: "settings.backup", Component: BackupSettings },
];

export default function Layout() {
	// Taken from https://preview.tabler.io/settings.html
	// Refer to that when updating this content
	const [active, setActive] = useState(TABS[0].key);
	const ActiveComponent = TABS.find((t) => t.key === active)?.Component ?? DefaultSite;

	return (
		<div className="card mt-4">
			<div className="card-status-top bg-teal" />
			<div className="card-table">
				<div className="card-header">
					<div className="row w-full">
						<h2 className="mt-1 mb-0">
							<T id="settings" />
						</h2>
					</div>
				</div>
				<div className="row g-0">
					<div className="col-12 col-md-3 border-end">
						<div className="card-body mt-0 pt-0">
							<div className="list-group list-group-transparent">
								{TABS.map((tab) => (
									<a
										key={tab.key}
										href="#"
										className={cn(
											"list-group-item list-group-item-action d-flex align-items-center",
											{ active: active === tab.key },
										)}
										onClick={(e) => {
											e.preventDefault();
											setActive(tab.key);
										}}
									>
										<T id={tab.label} />
									</a>
								))}
							</div>
						</div>
					</div>
					<div className="col-12 col-md-9 d-flex flex-column">
						<ActiveComponent />
					</div>
				</div>
			</div>
		</div>
	);
}

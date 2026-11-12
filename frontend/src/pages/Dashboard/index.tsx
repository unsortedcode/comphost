import {
	IconAlertTriangle,
	IconArrowsCross,
	IconBolt,
	IconBoltOff,
	IconDisc,
	IconShieldExclamation,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { HasPermission } from "src/components";
import { useDomains, useHostReport } from "src/hooks";
import { T } from "src/locale";
import { DEAD_HOSTS, PROXY_HOSTS, REDIRECTION_HOSTS, STREAMS, VIEW } from "src/modules/Permissions";
import { needsAttention } from "src/pages/Domains/kinds";

const Dashboard = () => {
	const { data: hostReport } = useHostReport();
	const navigate = useNavigate();
	const { data: domains } = useDomains();
	const attention = domains?.filter(needsAttention).length ?? 0;
	const certTrouble =
		domains?.filter((d) => d.enabled && (d.sslState === "expiring" || d.sslState === "expired")).length ?? 0;

	// A dashboard card that opens a filtered Domains view.
	const card = (to: string, color: string, icon: React.ReactNode, label: React.ReactNode) => (
		<div className="col-sm-6 col-lg-3">
			<a
				href={to}
				className="card card-sm card-link card-link-pop"
				onClick={(e) => {
					e.preventDefault();
					navigate(to);
				}}
			>
				<div className="card-body">
					<div className="row align-items-center">
						<div className="col-auto">
							<span className={`${color} text-white avatar`}>{icon}</span>
						</div>
						<div className="col">
							<div className="font-weight-medium">{label}</div>
						</div>
					</div>
				</div>
			</a>
		</div>
	);

	return (
		<div>
			<h2>
				<T id="dashboard" />
			</h2>
			<div className="row row-deck row-cards">
				{domains ? (
					<div className="col-12 mt-4">
						<div className="row row-cards">
							{card(
								"/domains?attention=1",
								attention ? "bg-orange" : "bg-green",
								<IconAlertTriangle />,
								<T id="dashboard.needs-attention" data={{ count: attention }} />,
							)}
							{card(
								"/domains?attention=1",
								certTrouble ? "bg-red" : "bg-green",
								<IconShieldExclamation />,
								<T id="dashboard.certificates-expiring" data={{ count: certTrouble }} />,
							)}
						</div>
					</div>
				) : null}
				<div className="col-12 my-4">
					<div className="row row-cards">
						<HasPermission section={PROXY_HOSTS} permission={VIEW} hideError>
							<div className="col-sm-6 col-lg-3">
								<a
									href="/domains?type=proxy"
									className="card card-sm card-link card-link-pop"
									onClick={(e) => {
										e.preventDefault();
										navigate("/domains?type=proxy");
									}}
								>
									<div className="card-body">
										<div className="row align-items-center">
											<div className="col-auto">
												<span className="bg-green text-white avatar">
													<IconBolt />
												</span>
											</div>
											<div className="col">
												<div className="font-weight-medium">
													<T id="proxy-hosts.count" data={{ count: hostReport?.proxy }} />
												</div>
											</div>
										</div>
									</div>
								</a>
							</div>
						</HasPermission>
						<HasPermission section={REDIRECTION_HOSTS} permission={VIEW} hideError>
							<div className="col-sm-6 col-lg-3">
								<a
									href="/domains?type=redirect"
									className="card card-sm card-link card-link-pop"
									onClick={(e) => {
										e.preventDefault();
										navigate("/domains?type=redirect");
									}}
								>
									<div className="card-body">
										<div className="row align-items-center">
											<div className="col-auto">
												<span className="bg-yellow text-white avatar">
													<IconArrowsCross />
												</span>
											</div>
											<div className="col">
												<T
													id="redirection-hosts.count"
													data={{ count: hostReport?.redirection }}
												/>
											</div>
										</div>
									</div>
								</a>
							</div>
						</HasPermission>
						<HasPermission section={STREAMS} permission={VIEW} hideError>
							<div className="col-sm-6 col-lg-3">
								<a
									href="/domains?type=stream"
									className="card card-sm card-link card-link-pop"
									onClick={(e) => {
										e.preventDefault();
										navigate("/domains?type=stream");
									}}
								>
									<div className="card-body">
										<div className="row align-items-center">
											<div className="col-auto">
												<span className="bg-blue text-white avatar">
													<IconDisc />
												</span>
											</div>
											<div className="col">
												<T id="streams.count" data={{ count: hostReport?.stream }} />
											</div>
										</div>
									</div>
								</a>
							</div>
						</HasPermission>
						<HasPermission section={DEAD_HOSTS} permission={VIEW} hideError>
							<div className="col-sm-6 col-lg-3">
								<a
									href="/domains?type=dead"
									className="card card-sm card-link card-link-pop"
									onClick={(e) => {
										e.preventDefault();
										navigate("/domains?type=dead");
									}}
								>
									<div className="card-body">
										<div className="row align-items-center">
											<div className="col-auto">
												<span className="bg-red text-white avatar">
													<IconBoltOff />
												</span>
											</div>
											<div className="col">
												<T id="dead-hosts.count" data={{ count: hostReport?.dead }} />
											</div>
										</div>
									</div>
								</a>
							</div>
						</HasPermission>
					</div>
				</div>
			</div>
		</div>
	);
};

export default Dashboard;

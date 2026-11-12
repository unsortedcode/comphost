import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import {
	ErrorNotFound,
	LoadingPage,
	Page,
	SiteContainer,
	SiteFooter,
	SiteHeader,
	SiteMenu,
	Unhealthy,
} from "src/components";
import { useAuthState } from "src/context";
import { useHealth } from "src/hooks";

const Setup = lazy(() => import("src/pages/Setup"));
const Login = lazy(() => import("src/pages/Login"));
const Dashboard = lazy(() => import("src/pages/Dashboard"));
const Settings = lazy(() => import("src/pages/Settings"));
const Certificates = lazy(() => import("src/pages/Certificates"));
const Access = lazy(() => import("src/pages/Access"));
const AuditLog = lazy(() => import("src/pages/AuditLog"));
const Users = lazy(() => import("src/pages/Users"));
const Domains = lazy(() => import("src/pages/Domains"));
const Stacks = lazy(() => import("src/pages/Stacks"));
const StackDetail = lazy(() => import("src/pages/Stacks/Detail"));

function Router() {
	const health = useHealth();
	const { authenticated } = useAuthState();

	if (health.isLoading) {
		return <LoadingPage />;
	}

	if (health.isError || health.data?.status !== "OK") {
		return <Unhealthy />;
	}

	if (!health.data?.setup) {
		return <Setup />;
	}

	if (!authenticated) {
		return (
			<Suspense fallback={<LoadingPage />}>
				<Login />
			</Suspense>
		);
	}

	return (
		<BrowserRouter>
			<Page>
				<div>
					<SiteHeader />
					<SiteMenu />
				</div>
				<SiteContainer>
					<Suspense fallback={<LoadingPage noLogo />}>
						<Routes>
							<Route path="*" element={<ErrorNotFound />} />
							<Route path="/certificates" element={<Certificates />} />
							<Route path="/access" element={<Access />} />
							<Route path="/audit-log" element={<AuditLog />} />
							<Route path="/settings" element={<Settings />} />
							<Route path="/users" element={<Users />} />
							<Route path="/domains" element={<Domains />} />
							{/* The per-type pages folded into Domains; keep old links working */}
							<Route path="/nginx/proxy" element={<Navigate to="/domains?type=proxy" replace />} />
							<Route
								path="/nginx/redirection"
								element={<Navigate to="/domains?type=redirect" replace />}
							/>
							<Route path="/nginx/404" element={<Navigate to="/domains?type=dead" replace />} />
							<Route path="/nginx/stream" element={<Navigate to="/domains?type=stream" replace />} />
							<Route path="/stacks" element={<Stacks />} />
							<Route path="/stacks/:id" element={<StackDetail />} />
							<Route path="/" element={<Dashboard />} />
						</Routes>
					</Suspense>
				</SiteContainer>
				<SiteFooter />
			</Page>
		</BrowserRouter>
	);
}

export default Router;

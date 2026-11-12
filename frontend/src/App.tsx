import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import EasyModal from "ez-modal-react";
import { RawIntlProvider } from "react-intl";
import { ToastContainer } from "react-toastify";
import { AuthProvider, LocaleProvider, ThemeProvider } from "src/context";
import { intl } from "src/locale";
import Router from "src/Router.tsx";

// The Domains list is assembled from every host kind plus stacks and
// certificates. Modals refresh only their own lists after a save, so refresh
// Domains whenever any of its sources is.
const DOMAIN_SOURCES = new Set([
	"proxy-hosts",
	"proxy-host",
	"redirection-hosts",
	"redirection-host",
	"dead-hosts",
	"dead-host",
	"streams",
	"stream",
	"stacks",
	"stack",
	"certificates",
	"certificate",
]);

class AppQueryClient extends QueryClient {
	override invalidateQueries(...args: Parameters<QueryClient["invalidateQueries"]>) {
		const key = args[0]?.queryKey?.[0];
		if (typeof key === "string" && DOMAIN_SOURCES.has(key)) {
			void super.invalidateQueries({ queryKey: ["domains"] });
		}
		return super.invalidateQueries(...args);
	}
}

const queryClient = new AppQueryClient();

function App() {
	return (
		<RawIntlProvider value={intl}>
			<LocaleProvider>
				<ThemeProvider>
					<QueryClientProvider client={queryClient}>
						<AuthProvider>
							<EasyModal.Provider>
								<Router />
							</EasyModal.Provider>
							<ToastContainer
								position="top-right"
								autoClose={5000}
								hideProgressBar={true}
								newestOnTop={true}
								closeOnClick={true}
								rtl={false}
								closeButton={false}
							/>
						</AuthProvider>
						<ReactQueryDevtools buttonPosition="bottom-right" position="right" />
					</QueryClientProvider>
				</ThemeProvider>
			</LocaleProvider>
		</RawIntlProvider>
	);
}

export default App;

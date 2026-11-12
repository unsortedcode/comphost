import { useQuery } from "@tanstack/react-query";
import { type DomainRow, getDomains } from "src/api/backend";

const useDomains = (options = {}) => {
	return useQuery<DomainRow[], Error>({
		queryKey: ["domains"],
		queryFn: getDomains,
		staleTime: 30 * 1000,
		...options,
	});
};

export { useDomains };

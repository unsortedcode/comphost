import { useQuery } from "@tanstack/react-query";
import { getStacks, type Stack, type StackExpansion } from "src/api/backend";

const fetchStacks = (expand?: StackExpansion[]) => {
	return getStacks(expand);
};

const useStacks = (expand?: StackExpansion[], options = {}) => {
	return useQuery<Stack[], Error>({
		queryKey: ["stacks", { expand }],
		queryFn: () => fetchStacks(expand),
		staleTime: 15 * 1000,
		...options,
	});
};

export { fetchStacks, useStacks };

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createStack, getStack, type Stack, updateStack } from "src/api/backend";

const DEFAULT_COMPOSE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
`;

const fetchStack = (id: number | "new") => {
	if (id === "new") {
		return Promise.resolve({
			id: 0,
			createdOn: "",
			modifiedOn: "",
			ownerUserId: 0,
			name: "",
			composeFileName: "compose.yaml",
			status: 1,
			meta: {},
			composeContent: DEFAULT_COMPOSE,
		} as Stack);
	}
	return getStack(id, ["owner"]);
};

const useStack = (id: number | "new", options = {}) => {
	return useQuery<Stack, Error>({
		queryKey: ["stack", id],
		queryFn: () => fetchStack(id),
		staleTime: 15 * 1000,
		...options,
	});
};

const useSetStack = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (values: Partial<Stack>) => (values.id ? updateStack(values) : createStack(values)),
		onSuccess: async (result: Stack) => {
			queryClient.invalidateQueries({ queryKey: ["stack", result.id] });
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
		},
	});
};

export { useStack, useSetStack, DEFAULT_COMPOSE };

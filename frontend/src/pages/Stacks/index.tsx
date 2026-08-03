import { HasPermission } from "src/components";
import { STACKS, VIEW } from "src/modules/Permissions";
import TableWrapper from "./TableWrapper";

const Stacks = () => {
	return (
		<HasPermission section={STACKS} permission={VIEW} pageLoading loadingNoLogo>
			<TableWrapper />
		</HasPermission>
	);
};

export default Stacks;

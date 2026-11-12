import type { DomainKind } from "src/api/backend";
import { T } from "src/locale";

// Same colours the per-type pages used, so the types stay recognisable.
const COLORS: Record<DomainKind, string> = {
	proxy: "bg-lime-lt",
	redirect: "bg-yellow-lt",
	dead: "bg-red-lt",
	stream: "bg-blue-lt",
};

export function HostKindFormatter({ kind }: { kind: DomainKind }) {
	return (
		<span className={`badge ${COLORS[kind]}`}>
			<T id={`host-kind.${kind}`} />
		</span>
	);
}

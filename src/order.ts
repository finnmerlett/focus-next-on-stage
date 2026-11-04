// Works out the order in which the Source Control view lists the files of a resource group, and
// which file to focus once some have left a list. This mirrors SCMTreeSorter in
// src/vs/workbench/contrib/scm/browser/scmViewPane.ts. Kept free of runtime vscode imports so the
// unit tests can load it under plain Node.
import { compareFileNames } from './paths';

export type ViewMode = 'tree' | 'list';
export type SortKey = 'path' | 'name' | 'status';

export interface OrderEntry {
	/** Path below the repository root, split into segments. */
	readonly segments: readonly string[];
	/** The status text the view sorts by with the status sort key, for example "Modified". */
	readonly statusLabel: string;
}

/** comparePathComponents in src/vs/base/common/comparers.ts: plain code units, lowercased unless caseSensitive. */
function comparePathComponents(one: string, other: string, caseSensitive: boolean): number {
	if (!caseSensitive) {
		one = one.toLowerCase();
		other = other.toLowerCase();
	}
	return one === other ? 0 : one < other ? -1 : 1;
}

/**
 * comparePaths in src/vs/base/common/comparers.ts. At each level a file sorts before a folder.
 * Folder names compare by code unit and only the file name uses the file-name collator, so
 * app10/ comes before app9/.
 */
export function comparePaths(one: readonly string[], other: readonly string[], caseSensitive = false): number {
	for (let i = 0; ; i++) {
		const endOne = i === one.length - 1;
		const endOther = i === other.length - 1;
		if (endOne && endOther) {
			return compareFileNames(one[i], other[i]);
		} else if (endOne) {
			return -1;
		} else if (endOther) {
			return 1;
		}
		const result = comparePathComponents(one[i], other[i], caseSensitive);
		if (result !== 0) {
			return result;
		}
	}
}

function compareInList(sortKey: SortKey, one: OrderEntry, other: OrderEntry): number {
	if (sortKey === 'name') {
		return compareFileNames(one.segments[one.segments.length - 1], other.segments[other.segments.length - 1]);
	}
	if (sortKey === 'status' && one.statusLabel !== other.statusLabel) {
		return one.statusLabel < other.statusLabel ? -1 : 1;
	}
	return comparePaths(one.segments, other.segments);
}

interface Folder<T> {
	readonly folders: Map<string, Folder<T>>;
	readonly files: T[];
}

function walkTree<T extends OrderEntry>(folder: Folder<T>, out: T[]): void {
	// Tree view lists folders before files at every level, each sorted by name. Compressed folder
	// chains (scm.compactFolders) are drawn as one row but keep the same order.
	for (const name of [...folder.folders.keys()].sort(compareFileNames)) {
		walkTree(folder.folders.get(name)!, out);
	}
	const last = (entry: T) => entry.segments[entry.segments.length - 1];
	out.push(...[...folder.files].sort((a, b) => compareFileNames(last(a), last(b))));
}

/** The entries in the order the view lists them, top to bottom. */
export function displayOrder<T extends OrderEntry>(entries: readonly T[], viewMode: ViewMode, sortKey: SortKey): T[] {
	if (viewMode === 'list') {
		// The extension host hands the view each group sorted by case-sensitive path
		// (compareResourceStates in extHostSCM.ts), and the view's sort is stable, so files with the
		// same name keep that order.
		return [...entries]
			.sort((a, b) => comparePaths(a.segments, b.segments, true))
			.sort((a, b) => compareInList(sortKey, a, b));
	}
	const root: Folder<T> = { folders: new Map(), files: [] };
	for (const entry of entries) {
		let folder = root;
		for (const segment of entry.segments.slice(0, -1)) {
			let next = folder.folders.get(segment);
			if (!next) {
				next = { folders: new Map(), files: [] };
				folder.folders.set(segment, next);
			}
			folder = next;
		}
		folder.files.push(entry);
	}
	const out: T[] = [];
	walkTree(root, out);
	return out;
}

function sharedFolders(one: readonly string[], other: readonly string[]): number {
	let i = 0;
	while (i < one.length && i < other.length && one[i] === other[i]) {
		i++;
	}
	return i;
}

/**
 * The file to focus once `moved` have left a list: the first remaining file below the first
 * moved one, or else the closest remaining file above it. `order` is the list before the move.
 * Files that `canFocus` rejects are passed over.
 *
 * With `folderOf`, which gives a file's folder segments, the files that share the most folders
 * with the moved one come first. Focus then stays inside the moved file's folder while it has
 * files left, and climbs out one level at a time as folders empty.
 */
export function neighbour(order: readonly string[], remaining: ReadonlySet<string>, moved: ReadonlySet<string>,
	canFocus: (file: string) => boolean = () => true, folderOf?: (file: string) => readonly string[]): string | undefined {
	const start = order.findIndex(file => moved.has(file));
	if (start === -1) {
		return undefined;
	}
	let usable = [...order.keys()].filter(i => remaining.has(order[i]) && !moved.has(order[i]) && canFocus(order[i]));
	if (folderOf) {
		const folder = folderOf(order[start]);
		const shared = (i: number) => sharedFolders(folderOf(order[i]), folder);
		const most = Math.max(-1, ...usable.map(shared));
		usable = usable.filter(i => shared(i) === most);
	}
	const below = usable.find(i => i > start);
	const above = usable.filter(i => i < start).pop();
	const index = below ?? above;
	return index === undefined ? undefined : order[index];
}

/**
 * The status text git shows for each status (Resource.getStatusText in extensions/git/src/repository.ts),
 * in English. The view sorts by the localized text, so the status sort can differ in other languages.
 */
const STATUS_LABELS = [
	'Index Modified', 'Index Added', 'Index Deleted', 'Index Renamed', 'Index Copied', 'Modified', 'Deleted',
	'Untracked', 'Ignored', 'Intent to Add', 'Intent to Rename', 'Type Changed', 'Conflict: Added By Us',
	'Conflict: Added By Them', 'Conflict: Deleted By Us', 'Conflict: Deleted By Them', 'Conflict: Both Added',
	'Conflict: Both Deleted', 'Conflict: Both Modified',
];

export function statusLabel(status: number): string {
	return STATUS_LABELS[status] ?? '';
}

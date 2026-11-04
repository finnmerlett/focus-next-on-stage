// Kept free of runtime vscode imports so the unit tests can load it under plain Node.
import type { Repository } from './git';
import { changesIn, GROUP_ORDER, GroupId, UNSTAGED_GROUPS } from './groups';
import { displayOrder, SortKey, statusLabel, ViewMode } from './order';
import { pathKey, segmentsBelow } from './paths';

export interface SnapshotEntry {
	/** Path key (see pathKey) used to compare files. */
	readonly key: string;
	readonly fsPath: string;
	readonly segments: readonly string[];
	readonly statusLabel: string;
}

/** The files in each group of a repository at one moment. */
export interface Snapshot {
	readonly entries: Readonly<Record<GroupId, readonly SnapshotEntry[]>>;
	readonly keys: Readonly<Record<GroupId, ReadonlySet<string>>>;
	/** The old paths of staged renames and copies, which the index lists under the new path. */
	readonly renamedFrom: ReadonlySet<string>;
}

// Status values of a staged rename and a staged copy (Status in git.d.ts).
const INDEX_RENAMED = 3;
const INDEX_COPIED = 4;

export function takeSnapshot(repository: Repository): Snapshot {
	const root = repository.rootUri.fsPath;
	const entries = {} as Record<GroupId, SnapshotEntry[]>;
	const keys = {} as Record<GroupId, Set<string>>;
	for (const group of GROUP_ORDER) {
		entries[group] = changesIn(repository, group).map(change => ({
			key: pathKey(change.uri.fsPath),
			fsPath: change.uri.fsPath,
			segments: segmentsBelow(root, change.uri.fsPath),
			statusLabel: statusLabel(change.status),
		}));
		keys[group] = new Set(entries[group].map(entry => entry.key));
	}
	const renamedFrom = new Set(repository.state.indexChanges
		.filter(change => change.status === INDEX_RENAMED || change.status === INDEX_COPIED)
		.map(change => pathKey(change.originalUri.fsPath)));
	return { entries, keys, renamedFrom };
}

function unstaged(snapshot: Snapshot): Set<string> {
	return new Set(UNSTAGED_GROUPS.flatMap(group => [...snapshot.keys[group]]));
}

/**
 * Files that were wholly staged between the two snapshots: no longer unstaged, and now in the
 * index. Staging the deleted old path of a renamed file turns the new path's row into a rename,
 * so the old path then only shows up as where the rename came from.
 */
export function stagedBetween(before: Snapshot, after: Snapshot): string[] {
	const afterUnstaged = unstaged(after);
	return [...unstaged(before)].filter(key => !afterUnstaged.has(key) && (after.keys.index.has(key) || after.renamedFrom.has(key)));
}

/** Files that left the index between the two snapshots. */
export function unstagedBetween(before: Snapshot, after: Snapshot): string[] {
	return [...before.keys.index].filter(key => !after.keys.index.has(key));
}

export type Side = 'unstaged' | 'staged';

/**
 * The files of one side of the view in the order it lists them: the unstaged groups one after
 * another (Merge Changes, Changes, Untracked Changes), or Staged Changes on its own.
 */
export function sideOrder(snapshot: Snapshot, side: Side, viewMode: ViewMode, sortKey: SortKey): SnapshotEntry[] {
	const groups = side === 'staged' ? (['index'] as const) : UNSTAGED_GROUPS;
	return groups.flatMap(group => displayOrder(snapshot.entries[group], viewMode, sortKey));
}

/**
 * Like sideOrder, with the files of both snapshots together, each at the place the view lists it.
 * A file can arrive on a side during a move: unstaging a staged rename leaves the deletion of the
 * old path staged.
 */
export function sideOrderBetween(before: Snapshot, after: Snapshot, side: Side, viewMode: ViewMode, sortKey: SortKey): SnapshotEntry[] {
	const groups = side === 'staged' ? (['index'] as const) : UNSTAGED_GROUPS;
	const seen = new Set<string>();
	return groups
		.flatMap(group => displayOrder([...before.entries[group], ...after.entries[group].filter(entry => !before.keys[group].has(entry.key))], viewMode, sortKey))
		.filter(entry => !seen.has(entry.key) && !!seen.add(entry.key));
}

/** The files on one side of the view. */
export function sideKeys(snapshot: Snapshot, side: Side): Set<string> {
	return side === 'staged' ? new Set(snapshot.keys.index) : unstaged(snapshot);
}

/** The group a file is in on one side of the view. */
export function groupOf(snapshot: Snapshot, key: string, side: Side): GroupId | undefined {
	const groups = side === 'staged' ? (['index'] as const) : UNSTAGED_GROUPS;
	return groups.find(group => snapshot.keys[group].has(key));
}

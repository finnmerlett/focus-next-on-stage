// Kept free of runtime vscode imports so the unit tests can load it under plain Node.
import type { Change, Repository } from './git';

/** Group ids of the git SCM provider, in the order the Source Control view shows them. */
export const GROUP_ORDER = ['merge', 'index', 'workingTree', 'untracked'] as const;
export type GroupId = typeof GROUP_ORDER[number];

/** Groups whose files count as unstaged, in display order. */
export const UNSTAGED_GROUPS: readonly GroupId[] = ['merge', 'workingTree', 'untracked'];

export function changesIn(repository: Repository, group: GroupId): readonly Change[] {
	const state = repository.state;
	switch (group) {
		case 'merge': return state.mergeChanges;
		case 'index': return state.indexChanges;
		case 'workingTree': return state.workingTreeChanges;
		case 'untracked': return state.untrackedChanges ?? [];
	}
}

export function hasUnstaged(repository: Repository): boolean {
	return UNSTAGED_GROUPS.some(group => changesIn(repository, group).length > 0);
}

// Kept free of runtime vscode imports so the unit tests can load it under plain Node.
import type { Repository } from './git';
import { hasUnstaged } from './groups';

export type Move = 'stage' | 'unstage';

/**
 * `next` is the file listed after the one that moved, or before it when that was the last.
 * The others are for when that side of the view is empty.
 */
export type Target = 'next' | 'topUnstaged' | 'lowestStaged' | 'commitInput';

export interface Settings {
	readonly whenAllStaged: 'commitInput' | 'lowestStaged' | 'none';
	readonly whenAllUnstaged: 'topUnstaged' | 'none';
	/** In tree view, prefer the next file inside the moved file's folder, then its parent folders. */
	readonly stayInFolder: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	whenAllStaged: 'commitInput',
	whenAllUnstaged: 'topUnstaged',
	stayInFolder: false,
};

/** Where focus should go after a stage or unstage, given the repository as it is now. */
export function pickTarget(move: Move, repository: Repository, settings: Settings, singleRepository: boolean): Target | undefined {
	const left = move === 'stage' ? hasUnstaged(repository) : repository.state.indexChanges.length > 0;
	return left ? 'next' : whenSideEmpty(move, repository, settings, singleRepository);
}

/**
 * Where focus should go when the side the files moved from has nothing left to focus. That side
 * can still have files that can't be focused, such as partly staged files after an unstage.
 */
export function whenSideEmpty(move: Move, repository: Repository, settings: Settings, singleRepository: boolean): Target | undefined {
	if (move === 'stage') {
		if (settings.whenAllStaged === 'commitInput') {
			// VS Code's command for the commit box picks the repository the view last opened a row
			// from, which with several repositories may not be this one.
			return singleRepository ? 'commitInput' : 'lowestStaged';
		}
		return settings.whenAllStaged === 'lowestStaged' && repository.state.indexChanges.length > 0 ? 'lowestStaged' : undefined;
	}
	return settings.whenAllUnstaged === 'topUnstaged' && hasUnstaged(repository) ? 'topUnstaged' : undefined;
}

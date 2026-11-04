import type { Change, Repository } from '../../git';

type Groups = { merge?: string[]; index?: string[]; workingTree?: string[]; untracked?: string[] };

const fileUri = (path: string) => ({ fsPath: `/repo/${path}`, toString: () => `file:///repo/${path}` });

/** A change for `path`, or a staged rename for `new.txt<-old.txt`. */
const change = (path: string): Change => {
	const [to, from] = path.split('<-');
	return { uri: fileUri(to), originalUri: fileUri(from ?? to), status: from ? 3 : 0 } as unknown as Change;
};

/** A repository whose state holds these files in these groups. */
export function fakeRepository(groups: Groups): Repository {
	return {
		rootUri: { fsPath: '/repo' },
		state: {
			mergeChanges: (groups.merge ?? []).map(change),
			indexChanges: (groups.index ?? []).map(change),
			workingTreeChanges: (groups.workingTree ?? []).map(change),
			untrackedChanges: (groups.untracked ?? []).map(change),
		},
	} as unknown as Repository;
}

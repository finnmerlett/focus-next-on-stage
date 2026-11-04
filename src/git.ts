import * as vscode from 'vscode';

// The parts of the built-in git extension's public API (extensions/git/src/api/git.d.ts) used here.
export interface Change {
	readonly uri: vscode.Uri;
	readonly originalUri: vscode.Uri;
	readonly status: number;
}

export interface RepositoryState {
	readonly mergeChanges: readonly Change[];
	readonly indexChanges: readonly Change[];
	readonly workingTreeChanges: readonly Change[];
	readonly untrackedChanges: readonly Change[];
	/** Fires after each git status run, once the git extension has updated its groups. */
	readonly onDidChange: vscode.Event<void>;
}

export interface Repository {
	readonly rootUri: vscode.Uri;
	readonly state: RepositoryState;
}

export interface GitApi {
	readonly repositories: readonly Repository[];
	getRepository(uri: vscode.Uri): Repository | null;
}

// Internal git extension objects, reached through the undocumented `model` getter on the
// extension's exports (extensions/git/src/api/extension.ts). They aren't API, so every use
// checks the shape first and the extension still works without them.
export type InternalResource = vscode.SourceControlResourceState;

export interface InternalGroup {
	readonly resourceStates: readonly InternalResource[];
}

export interface InternalRepository {
	readonly root: string;
	readonly mergeGroup: InternalGroup;
	readonly indexGroup: InternalGroup;
	readonly workingTreeGroup: InternalGroup;
	readonly untrackedGroup: InternalGroup;
	/** Fires with the operation kind, for example "Add", before the operation runs. */
	readonly onRunOperation: vscode.Event<string>;
	/** Fires after the operation and the status refresh that follows it. */
	readonly onDidRunOperation: vscode.Event<{ readonly operation: { readonly kind: string }; readonly error: unknown }>;
}

export interface InternalModel {
	readonly repositories: readonly InternalRepository[];
	readonly onDidOpenRepository: vscode.Event<InternalRepository>;
	readonly onDidCloseRepository?: vscode.Event<InternalRepository>;
}

export interface Git {
	readonly api: GitApi;
	readonly model: InternalModel | undefined;
}

function isInternalModel(value: unknown): value is InternalModel {
	const model = value as InternalModel | undefined;
	return !!model && Array.isArray(model.repositories) && typeof model.onDidOpenRepository === 'function';
}

export function isInternalRepository(value: unknown): value is InternalRepository {
	const repository = value as InternalRepository | undefined;
	return !!repository && typeof repository.root === 'string'
		&& typeof repository.onRunOperation === 'function'
		&& typeof repository.onDidRunOperation === 'function'
		&& [repository.mergeGroup, repository.indexGroup, repository.workingTreeGroup, repository.untrackedGroup]
			.every(group => Array.isArray(group?.resourceStates));
}

interface GitExtensionExports {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: vscode.Event<boolean>;
	readonly model?: unknown;
	getAPI(version: 1): GitApi;
}

/** Resolves once the git extension is active and enabled, or undefined if it isn't installed. */
export async function getGit(): Promise<Git | undefined> {
	const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (!extension) {
		return undefined;
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	if (!exports.enabled) {
		// git.enabled is off. Wait for it to be turned on.
		await new Promise<void>(resolve => {
			const listener = exports.onDidChangeEnablement(enabled => {
				if (enabled) {
					listener.dispose();
					resolve();
				}
			});
		});
	}
	const model = isInternalModel(exports.model) ? exports.model : undefined;
	return { api: exports.getAPI(1), model };
}

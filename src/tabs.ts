import * as vscode from 'vscode';

/** The file path an editor URI refers to. A git: URI carries the path in its JSON query. */
function filePathOf(uri: vscode.Uri | undefined): string | undefined {
	if (uri?.scheme === 'file') {
		return uri.fsPath;
	}
	if (uri?.scheme === 'git') {
		// extensions/git/src/uri.ts puts the file path and ref in the query.
		try {
			const query = JSON.parse(uri.query) as { path?: unknown };
			return typeof query.path === 'string' ? query.path : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The file a merge editor tab resolves, or undefined for other tabs. TabInputTextMerge is
 * proposed API that isn't in @types/vscode 1.93, but the extension host creates it for every
 * merge editor tab, so the class is looked up at runtime.
 */
function mergeResultOf(input: unknown): vscode.Uri | undefined {
	const merge = (vscode as unknown as Record<string, unknown>).TabInputTextMerge;
	const result = typeof merge === 'function' && input instanceof merge ? (input as { result?: unknown }).result : undefined;
	return result instanceof vscode.Uri ? result : undefined;
}

/**
 * The path of the file in the active tab, as an fsPath. For a diff this is the modified side,
 * which is where a Source Control click puts the resource.
 */
export function activeTabFile(): string | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return filePathOf(input.modified) ?? filePathOf(input.original);
	}
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom) {
		return filePathOf(input.uri);
	}
	// Image editors and image diffs have no input in the API.
	return filePathOf(mergeResultOf(input));
}

/**
 * The URIs of a tab: the URI for a file, "original|modified" for a diff, or "merge:" and the
 * file for the merge editor. Undefined for other tabs.
 */
export function tabUris(tab: vscode.Tab | undefined): string | undefined {
	const input = tab?.input;
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return `${input.original}|${input.modified}`;
	}
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom) {
		return input.uri.toString();
	}
	const result = mergeResultOf(input);
	return result && mergeTabUris(result);
}

/** The tabUris of the merge editor for this file. */
export const mergeTabUris = (file: vscode.Uri) => `merge:${file}`;

/**
 * True when the active tab is the multi-file diff editor (View Changes). Its file headers have
 * their own stage buttons, and the class isn't in @types/vscode 1.93, so it is looked up at
 * runtime.
 */
export function activeTabIsMultiDiff(): boolean {
	const multiDiff = (vscode as unknown as Record<string, unknown>).TabInputTextMultiDiff;
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return typeof multiDiff === 'function' && input instanceof multiDiff;
}

/** A string that changes whenever a different editor becomes the active tab. */
export function activeTabKey(): string {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (!tab) {
		return '';
	}
	const input = tab.input as { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri; result?: vscode.Uri } | undefined;
	const parts = [input?.uri, input?.original, input?.modified, input?.result].map(uri => uri?.toString() ?? '');
	return [tab.label, ...parts].join('|');
}

/**
 * True when a different tab than `before` is active. A moment with no active tab doesn't count:
 * replacing a preview tab sends the close, the open and the activation as separate updates, and
 * between the first and the last no tab is active.
 */
export const activeTabChangedFrom = (before: string) => {
	const key = activeTabKey();
	return key !== '' && key !== before;
};

/** Resolves true when the active tab changes, or false after `timeout` ms. */
export function waitForActiveTabChange(before: string, timeout: number): Promise<boolean> {
	return new Promise(resolve => {
		if (activeTabChangedFrom(before)) {
			resolve(true);
			return;
		}
		const done = (changed: boolean) => {
			clearTimeout(timer);
			listeners.forEach(listener => listener.dispose());
			resolve(changed);
		};
		const check = () => {
			if (activeTabChangedFrom(before)) {
				done(true);
			}
		};
		// Opening an editor in another group than the active one also makes that group active.
		const listeners = [vscode.window.tabGroups.onDidChangeTabs(check), vscode.window.tabGroups.onDidChangeTabGroups(check)];
		const timer = setTimeout(() => done(false), timeout);
	});
}

/**
 * Runs a command in the window that replies straight away. The window sends tab updates in
 * order with replies, so once this resolves, every tab change from work the window had already
 * finished has reached the extension.
 */
export const roundTrip = () => vscode.commands.executeCommand('setContext', 'focusNextOnStage.roundTrip', true);

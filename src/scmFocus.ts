import * as vscode from 'vscode';
import type { InternalResource } from './git';
import type { GroupId } from './groups';
import { activeTabChangedFrom, activeTabKey, mergeTabUris, tabUris, waitForActiveTabChange } from './tabs';

// VS Code has no API for focusing a row in the Source Control view. Opening a file the way a click
// on its row does makes scm.autoReveal (on by default) focus and select that row. The reveal only
// scrolls when the row is out of sight, and it doesn't move keyboard focus.

/** A file to focus, and the row it is in. */
export interface FileTarget {
	readonly fsPath: string;
	readonly group: GroupId;
	/** The git extension's own row resource. Its command is what a click on the row runs. */
	readonly resource: InternalResource;
	/**
	 * True when the file just moved, or its row wasn't in this group before the move (unstaging a
	 * staged rename leaves the deletion of the old path staged). The view may not show the row
	 * there yet.
	 */
	readonly rowJustChanged: boolean;
}

export interface Logger {
	debug(message: string): void;
	warn(message: string): void;
}

const OPEN_TIMEOUT = 800;
// The extension host sends SCM changes to the view 100ms after the git extension updates its
// groups, and the commit box command waits behind the refresh that follows.
const SETTLE_DELAY = 150;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The command a click on the row runs, with the options of a single click. */
interface Click {
	readonly id: string;
	/** The command's arguments, opening its editor in `viewColumn`, or where a click would. */
	readonly args: (viewColumn: vscode.ViewColumn | undefined) => unknown[];
	/** The URI autoReveal looks at when the click's editor becomes active. */
	readonly primary: vscode.Uri | undefined;
	/** The click's editor as tabUris gives it, when it is a text file, a diff or the merge editor. */
	readonly tab: string | undefined;
}

// Commands that return once their editor is open, when given editor options. The window sends tab
// updates before the reply, so a tab change has arrived by then. git's merge editor commands
// return before the editor opens.
const OPENS_BEFORE_RETURNING = new Set(['vscode.diff', 'vscode.open']);

// git's commands for a conflict when git.mergeEditor is on. They take the file's URI.
const MERGE_EDITOR_COMMANDS = new Set(['git.openMergeEditor', 'git.openWorktreeMergeEditor']);

/** The command a click on the row runs. */
function clickCommand(resource: InternalResource): Click | undefined {
	const command = resource.command;
	if (!command) {
		return undefined;
	}
	const args = command.arguments ?? [];
	const single = (viewColumn: vscode.ViewColumn | undefined) => viewColumn === undefined
		? { preview: true, preserveFocus: true }
		: { preview: true, preserveFocus: true, viewColumn };
	if (command.command === 'vscode.diff') {
		// vscode.diff(left, right, title, options)
		const [left, right] = args;
		if (!(left instanceof vscode.Uri) || !(right instanceof vscode.Uri)) {
			return undefined;
		}
		const options = args[3] as object | undefined;
		return { id: command.command, args: column => [left, right, args[2], { ...options, ...single(column) }], primary: right, tab: `${left}|${right}` };
	}
	if (command.command === 'vscode.open') {
		// vscode.open(uri, options, title). Git passes its own options, such as the editor override.
		// Some conflict rows, such as "added by us", have no URI, and a click on them fails too.
		const [uri] = args;
		if (!(uri instanceof vscode.Uri)) {
			return undefined;
		}
		const options = typeof args[1] === 'object' && args[1] !== null ? args[1] : undefined;
		return { id: command.command, args: column => [uri, { ...options, ...single(column) }, ...args.slice(2)], primary: uri, tab: uri.toString() };
	}
	// git.openMergeEditor(uri) for a conflict when git.mergeEditor is on. The merge editor's main
	// URI is the file. The command takes no editor options.
	const [uri] = args;
	const primary = uri instanceof vscode.Uri ? uri : undefined;
	return { id: command.command, args: () => args, primary, tab: primary && MERGE_EDITOR_COMMANDS.has(command.command) ? mergeTabUris(primary) : undefined };
}

let warnedAboutAutoReveal = false;

/**
 * Opens the file the way a click on its row does, which makes scm.autoReveal focus and select the
 * row. autoReveal only matches a file: URI, and only reacts when the active editor changes. So for
 * a staged diff or a deleted file, or when the click's editor is already active, the file itself
 * is opened as well, and closed again afterwards if that added a tab. Once the file is open, a
 * cancel doesn't stop the click, so the file's tab is always closed again.
 */
export async function focusFile(file: FileTarget, token: vscode.CancellationToken, log: Logger): Promise<void> {
	if (!vscode.workspace.getConfiguration('scm').get<boolean>('autoReveal', true)) {
		if (!warnedAboutAutoReveal) {
			warnedAboutAutoReveal = true;
			log.warn('scm.autoReveal is off, so Source Control rows can\'t be focused. Turn it on to use this extension.');
		}
		return;
	}
	if (token.isCancellationRequested) {
		return;
	}
	// A click opens its editor in the active group, or in another one if the active group is
	// locked, or where it is already open with workbench.editor.revealIfOpen on. The click's first
	// open leaves the choice to VS Code too, and the opens after it name the group it chose, so they
	// stay together if another group becomes active meanwhile.
	let group = vscode.window.tabGroups.activeTabGroup;
	let column: vscode.ViewColumn | undefined;
	const plain = vscode.Uri.file(file.fsPath);
	const click = clickCommand(file.resource);
	const active = tabUris(group.activeTab);
	const plainActive = active === plain.toString();
	const clickActive = !!click?.tab && active === click.tab;
	const run = async (id: string, args: unknown[]) => {
		const before = activeTabKey();
		await vscode.commands.executeCommand(id, ...args);
		const changed = OPENS_BEFORE_RETURNING.has(id) ? activeTabChangedFrom(before) : await waitForActiveTabChange(before, OPEN_TIMEOUT);
		if (column === undefined) {
			group = vscode.window.tabGroups.activeTabGroup;
			column = group.viewColumn;
		}
		return changed;
	};
	const runClick = (click: Click) => run(click.id, click.args(column));
	// The tab a temporary open of the file added, which is closed once the click's editor is open.
	let plainTab: vscode.Tab | undefined;
	const openPlain = async (temporary: boolean) => {
		const tabsBefore = new Set(vscode.window.tabGroups.all.flatMap(g => g.tabs));
		const preview = !(temporary && pinTemporaryOpen(group, plain));
		const changed = await run('vscode.open', [plain, column === undefined ? { preview, preserveFocus: true } : { preview, preserveFocus: true, viewColumn: column }]);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (temporary && tab && !tabsBefore.has(tab)) {
			plainTab = tab;
		}
		return changed;
	};
	const closePlain = async () => {
		const tab = plainTab;
		// A tab that has gone, for example replaced by a preview, can't be closed.
		if (tab && tab.group.tabs.includes(tab) && !tab.isActive && !tab.isDirty) {
			await vscode.window.tabGroups.close(tab, true);
		}
	};

	try {
		if (!click || click.primary?.scheme === 'file') {
			// The click's editor (or the file, for a row whose click fails) reveals the row by itself,
			// unless it is already the active editor.
			const editorActive = click ? clickActive : plainActive;
			if (editorActive && (!click || click.tab === plain.toString())) {
				log.debug(`${file.fsPath} is already the active editor, so its row can't be focused`);
				return;
			}
			if (editorActive) {
				// The click's editor is active, so a click would show it in this group. Open the file here
				// first to change the active editor.
				column = group.viewColumn;
				await openPlain(true);
			}
			const changed = click ? await runClick(click) : await openPlain(false);
			log.debug(changed ? `Focused ${file.fsPath} in ${file.group}` : `Opened ${file.fsPath} in ${file.group}, but the active editor didn't change`);
			return;
		}

		// The click opens git: URIs, which autoReveal doesn't match. The click runs first, which picks
		// the group and leaves an editor other than the file active. Then the file is opened in that
		// group to reveal the row, and the click's editor is shown again.
		await runClick(click);
		if (token.isCancellationRequested) {
			return;
		}
		const revealed = await openPlain(true);
		const changed = await runClick(click);
		log.debug(revealed && changed ? `Focused ${file.fsPath} in ${file.group}` : `Opened ${file.fsPath} in ${file.group}, but the active editor didn't change`);
	} finally {
		await closePlain();
	}
}

/**
 * Whether a temporary open of the file should be pinned. A preview open replaces the group's
 * preview tab, and the click's editor then replaces the file's tab, which a click on the row would
 * do too. Only when the click's editor is already pinned and another file holds the preview would
 * the click leave that file alone, so only then is the file's tab pinned. The click's editor is
 * the group's active tab whenever the file is opened temporarily, which also covers image diffs,
 * whose tabs have no input in the API.
 */
function pinTemporaryOpen(group: vscode.TabGroup, plain: vscode.Uri): boolean {
	const clickTab = group.activeTab;
	return !!clickTab && !clickTab.isPreview
		&& !group.tabs.some(tab => tabUris(tab) === plain.toString())
		&& group.tabs.some(tab => tab !== clickTab && tab.isPreview);
}

/** Focuses the commit message box of the repository the view last opened a row from. */
export async function focusCommitInput(token: vscode.CancellationToken): Promise<void> {
	await sleep(SETTLE_DELAY);
	if (!token.isCancellationRequested) {
		await vscode.commands.executeCommand('workbench.scm.action.focusNextInput');
	}
}

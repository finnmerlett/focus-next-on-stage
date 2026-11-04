import * as vscode from 'vscode';
import { groupOf, Side, sideKeys, sideOrder, sideOrderBetween, Snapshot, stagedBetween, takeSnapshot, unstagedBetween } from './changes';
import { getGit, Git, InternalGroup, InternalRepository, InternalResource, isInternalRepository, Repository } from './git';
import type { GroupId } from './groups';
import { neighbour, SortKey, ViewMode } from './order';
import { isInside, pathKey } from './paths';
import { FileTarget, focusCommitInput, focusFile } from './scmFocus';
import { activeTabChangedFrom, activeTabFile, activeTabIsMultiDiff, activeTabKey, roundTrip, waitForActiveTabChange } from './tabs';
import { DEFAULT_SETTINGS, Move, pickTarget, Settings, Target, whenSideEmpty } from './targets';

// Operations of the git extension that move whole files in or out of the index. "Remove" is
// git rm, which the inline + runs when a deletion conflict is resolved by deleting the file.
const STAGE_KINDS = new Set(['Add', 'Remove']);
const UNSTAGE_KINDS = new Set(['RevertFiles']);

// The e2e tests set this, because the hidden test window never has OS focus, and the extension
// doesn't follow stages in a window that isn't focused.
const IGNORE_WINDOW_FOCUS = process.env.FLN_TEST_IGNORE_WINDOW_FOCUS === '1';
const windowFocused = () => IGNORE_WINDOW_FOCUS || vscode.window.state.focused;

// The extension host sends the git extension's groups to the view 100ms after they last changed,
// and until then autoReveal would find a file that just moved in the row it left. Before focusing
// such a file, the extension waits until git's state has been quiet for longer than that.
const QUIET_BEFORE_REVEAL = 150;
const MAX_WAIT_BEFORE_REVEAL = 1000;

// How long to wait for the highlighted row's editor to open before staging, for rows whose click
// doesn't open the editor straight away (see opensStraightAway). A row whose file is already
// open doesn't change the active tab, so a key press on such a row waits this long. Merge editor
// opens took 60 to 100 ms in the e2e tests.
const HIGHLIGHT_OPEN_TIMEOUT = 250;

// How long a key press waits for the previous one to move focus, once its stage or unstage has
// finished, before running anyway.
const PREVIOUS_FOCUS_TIMEOUT = 1500;
// How many key presses can wait for the ones before them. Further presses are ignored, so holding
// a key down doesn't go on staging files long after it is let go.
const MAX_WAITING_PRESSES = 4;

// The view mode and sort order of the Source Control view, last passed in a keybinding's args.
// The toolbar toggle keeps them in workspace storage, which extensions can't read, and a
// keybinding can pass them by checking the scmViewMode and scmViewSortKey context keys.
const VIEW_MODE_KEY = 'focusNextOnStage.viewMode';
const SORT_KEY_KEY = 'focusNextOnStage.viewSortKey';
const VIEW_MODES: readonly string[] = ['tree', 'list'];
const SORT_KEYS: readonly string[] = ['path', 'name', 'status'];

function groupOfInternal(repository: InternalRepository, group: GroupId): InternalGroup {
	switch (group) {
		case 'merge': return repository.mergeGroup;
		case 'index': return repository.indexGroup;
		case 'workingTree': return repository.workingTreeGroup;
		case 'untracked': return repository.untrackedGroup;
	}
}

function readSettings(): Settings {
	// The settings are window-scoped, because the Source Control view is shared by the window.
	const config = vscode.workspace.getConfiguration('focusNextOnStage');
	return {
		whenAllStaged: config.get('whenAllStaged', DEFAULT_SETTINGS.whenAllStaged),
		whenAllUnstaged: config.get('whenAllUnstaged', DEFAULT_SETTINGS.whenAllUnstaged),
		stayInFolder: config.get('stayInFolder', DEFAULT_SETTINGS.stayInFolder),
	};
}

/** Stage and unstage operations running in one repository, and the groups from before the first. */
interface Running {
	count: number;
	readonly before: Snapshot;
	lastKind: string;
}

/** Resolves once `event` hasn't fired for `quiet` ms, after `max` ms, or on cancellation. */
function whenQuiet(event: vscode.Event<void>, quiet: number, max: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise(resolve => {
		let timer = setTimeout(done, quiet);
		const cap = setTimeout(done, max);
		const listener = event(() => {
			clearTimeout(timer);
			timer = setTimeout(done, quiet);
		});
		const cancel = token.onCancellationRequested(done);
		function done() {
			clearTimeout(timer);
			clearTimeout(cap);
			listener.dispose();
			cancel.dispose();
			resolve();
		}
	});
}

/**
 * True when the Source Control view opens a click's editor before it handles the next request
 * from the extension: vscode.diff, or vscode.open with editor options. vscode.open with no
 * options (git.openDiffOnClick off) checks the file first, and the merge editor commands run in
 * the git extension.
 */
function opensStraightAway(command: vscode.Command | undefined): boolean {
	const args = command?.arguments ?? [];
	return !command || command.command === 'vscode.diff'
		|| (command.command === 'vscode.open' && typeof args[1] === 'object' && args[1] !== null);
}

class Controller implements vscode.Disposable {
	private git: Git | undefined;
	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly watched = new Map<InternalRepository, vscode.Disposable[]>();
	private readonly running = new Map<InternalRepository, Running>();
	private warnedAboutShape = false;
	/** How many stage or unstage commands of this extension are running. */
	private commandsRunning = 0;
	private current: vscode.CancellationTokenSource | undefined;
	/** The last focus move started, which the next one waits for. */
	private lastFocus: Promise<void> = Promise.resolve();
	/** The last key press: when its stage or unstage finished, and when it finished moving focus. */
	private lastPress: { readonly moved: Promise<void>; readonly done: Promise<void> } = { moved: Promise.resolve(), done: Promise.resolve() };
	/** Key presses waiting for the one before them. */
	private waitingPresses = 0;
	/** Settles once the git extension is connected, so a command run at startup can wait for it. */
	readonly ready: Promise<void>;

	constructor(private readonly log: vscode.LogOutputChannel, private readonly memento: vscode.Memento) {
		this.ready = this.start().catch(err => log.error(`Couldn't start: ${err}`));
		// A move that is still running shouldn't open a file after the user has moved on. Editors this
		// extension opens keep focus where it is, so they never report a keyboard or mouse selection
		// change.
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(e => {
				if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
					this.cancelCurrent('the editor was used');
				}
			}),
			vscode.window.onDidChangeWindowState(state => {
				if (!state.focused && !IGNORE_WINDOW_FOCUS) {
					this.cancelCurrent('the window lost focus');
				}
			}),
		);
	}

	private async start(): Promise<void> {
		this.git = await getGit();
		if (this.disposed) {
			return;
		}
		if (!this.git) {
			this.log.warn('The built-in git extension is not available');
			return;
		}
		const model = this.git.model;
		if (!model) {
			this.log.warn('The git extension does not expose its model, so focus doesn\'t move after staging. The commands still stage and unstage.');
			return;
		}
		model.repositories.forEach(repository => this.watch(repository));
		this.disposables.push(model.onDidOpenRepository(repository => this.watch(repository)));
		if (typeof model.onDidCloseRepository === 'function') {
			this.disposables.push(model.onDidCloseRepository(repository => this.unwatch(repository)));
		}
	}

	private watch(internal: InternalRepository): void {
		if (this.watched.has(internal)) {
			return;
		}
		if (!isInternalRepository(internal)) {
			if (!this.warnedAboutShape) {
				this.warnedAboutShape = true;
				this.log.warn('The git extension\'s repositories have an unexpected shape, so focus doesn\'t move after staging. The commands still stage and unstage.');
			}
			return;
		}
		this.watched.set(internal, [
			internal.onRunOperation(kind => {
				if (!STAGE_KINDS.has(kind) && !UNSTAGE_KINDS.has(kind)) {
					return;
				}
				const running = this.running.get(internal);
				if (running) {
					running.count++;
					return;
				}
				const repository = this.publicRepository(internal);
				if (repository) {
					this.running.set(internal, { count: 1, before: takeSnapshot(repository), lastKind: kind });
				}
			}),
			internal.onDidRunOperation(({ operation, error }) => {
				const kind = operation?.kind;
				const running = this.running.get(internal);
				if (!running || !kind || (!STAGE_KINDS.has(kind) && !UNSTAGE_KINDS.has(kind))) {
					return;
				}
				running.lastKind = kind;
				// Overlapping operations are followed once, when the last one ends, comparing the
				// groups with how they were before the first one started.
				if (--running.count > 0) {
					return;
				}
				this.running.delete(internal);
				const repository = this.publicRepository(internal);
				if (!repository || error || this.commandsRunning > 0) {
					return;
				}
				const preferred: Move = UNSTAGE_KINDS.has(running.lastKind) ? 'unstage' : 'stage';
				const other: Move = preferred === 'stage' ? 'unstage' : 'stage';
				if (!this.onMoved(preferred, repository, running.before, 'automatic')) {
					this.onMoved(other, repository, running.before, 'automatic');
				}
			}),
		]);
	}

	private unwatch(internal: InternalRepository): void {
		this.watched.get(internal)?.forEach(d => d.dispose());
		this.watched.delete(internal);
		this.running.delete(internal);
	}

	private publicRepository(internal: InternalRepository): Repository | undefined {
		return this.git?.api.getRepository(vscode.Uri.file(internal.root)) ?? undefined;
	}

	/**
	 * Moves focus if `move` took at least one file across. Returns undefined when nothing moved,
	 * otherwise a promise that settles once focus has moved.
	 */
	private onMoved(move: Move, repository: Repository, before: Snapshot, source: 'automatic' | 'command'): Promise<void> | undefined {
		const after = takeSnapshot(repository);
		const moved = move === 'stage' ? stagedBetween(before, after) : unstagedBetween(before, after);
		if (moved.length === 0) {
			return undefined;
		}
		// The multi-file diff editor has stage buttons on each file, and opening the next file would
		// replace it.
		if (source === 'automatic' && (!windowFocused() || activeTabIsMultiDiff())) {
			return Promise.resolve();
		}
		const settings = readSettings();
		const singleRepository = (this.git?.api.repositories.length ?? 0) <= 1;
		const movedKeys = new Set(moved);
		let target = pickTarget(move, repository, settings, singleRepository);
		let file = target === 'next' ? this.fileFor('next', move, repository, before, after, movedKeys, settings.stayInFolder) : undefined;
		if (target === 'next' && !file && this.internalRepository(repository)) {
			// The files left on that side can't be focused, for example because they are partly staged.
			// Without the git extension's internal repository no file can be focused at all, and
			// focus stays where it is.
			target = whenSideEmpty(move, repository, settings, singleRepository);
		}
		this.log.debug(`${move} of ${moved.length} file(s) (${source}): focusing ${target ?? 'nothing'}`);
		if (!target) {
			return Promise.resolve();
		}
		if (target === 'commitInput') {
			return this.startFocus(token => focusCommitInput(token));
		}
		file ??= this.fileFor(target, move, repository, before, after, movedKeys, settings.stayInFolder);
		if (!file) {
			return Promise.resolve();
		}
		const found = file;
		return this.startFocus(async token => {
			if (found.rowJustChanged) {
				await whenQuiet(repository.state.onDidChange, QUIET_BEFORE_REVEAL, MAX_WAIT_BEFORE_REVEAL, token);
			}
			await focusFile(found, token, this.log);
		});
	}

	/**
	 * The file for a target: for `next`, the file listed after the moved ones on their side of the
	 * view, or before them if they were last. For the others, the top or bottom file on that side as
	 * it is now, which can be one that just moved.
	 */
	private fileFor(target: Exclude<Target, 'commitInput'>, move: Move, repository: Repository, before: Snapshot, after: Snapshot,
		moved: ReadonlySet<string>, stayInFolder: boolean): FileTarget | undefined {
		const internal = this.internalRepository(repository);
		if (!internal) {
			return undefined;
		}
		const side: Side = target === 'next' ? (move === 'stage' ? 'unstaged' : 'staged') : (target === 'topUnstaged' ? 'unstaged' : 'staged');
		const { mode, sortKey } = this.viewMode();
		const order = target === 'next' ? sideOrderBetween(before, after, side, mode, sortKey) : sideOrder(after, side, mode, sortKey);
		const resourceFor = (key: string) => {
			const group = groupOf(after, key, side);
			const resource = group && groupOfInternal(internal, group).resourceStates.find(r => pathKey(r.resourceUri.fsPath) === key);
			return group && resource ? { group, resource } : undefined;
		};
		// scm.autoReveal picks the unstaged row of a file that has changes in both groups, so a staged
		// row can only be focused when the file has no unstaged changes.
		const canFocus = (key: string) => !!resourceFor(key)
			&& (side === 'unstaged' || !(after.keys.workingTree.has(key) || after.keys.untracked.has(key)));
		const keys = order.map(entry => entry.key);
		// List view has no folder rows, so staying in a folder only applies to tree view.
		const segments = new Map(order.map(entry => [entry.key, entry.segments]));
		const folderOf = stayInFolder && mode === 'tree' ? (key: string) => (segments.get(key) ?? []).slice(0, -1) : undefined;
		const key = target === 'next' ? neighbour(keys, sideKeys(after, side), moved, canFocus, folderOf)
			: target === 'topUnstaged' ? keys.find(canFocus)
			: [...keys].reverse().find(canFocus);
		const found = key ? resourceFor(key) : undefined;
		if (!key || !found) {
			this.log.debug(`Nothing to focus for ${target} (${mode} view, sorted by ${sortKey})`);
			return undefined;
		}
		const rowJustChanged = moved.has(key) || !before.keys[found.group].has(key);
		return { fsPath: found.resource.resourceUri.fsPath, group: found.group, resource: found.resource, rowJustChanged };
	}

	private internalRepository(repository: Repository): InternalRepository | undefined {
		const root = pathKey(repository.rootUri.fsPath);
		return this.git?.model?.repositories.find(r => isInternalRepository(r) && pathKey(r.root) === root);
	}

	private viewMode(): { mode: ViewMode; sortKey: SortKey } {
		const scm = vscode.workspace.getConfiguration('scm');
		const mode = this.memento.get<ViewMode>(VIEW_MODE_KEY) ?? (scm.get('defaultViewMode') === 'tree' ? 'tree' : 'list');
		const sortKey = this.memento.get<SortKey>(SORT_KEY_KEY) ?? scm.get<SortKey>('defaultViewSortKey', 'path');
		return { mode, sortKey: SORT_KEYS.includes(sortKey) ? sortKey : 'path' };
	}

	/**
	 * Keeps the view mode and sort order a keybinding passed, as { viewMode, viewSortKey }, and
	 * returns true if it passed either. Only list view has a sort order, so a sort order on its
	 * own means list view. A binding with no sort order, such as the README's plain list entry,
	 * runs when no sort-order entry matched, so the stored sort order is cleared and
	 * scm.defaultViewSortKey applies.
	 */
	private rememberView(args: unknown): boolean {
		const view = args as { viewMode?: unknown; viewSortKey?: unknown } | undefined;
		if (view?.viewMode === undefined && view?.viewSortKey === undefined) {
			return false;
		}
		const sortKey = typeof view.viewSortKey === 'string' && SORT_KEYS.includes(view.viewSortKey) ? view.viewSortKey : undefined;
		const mode = typeof view.viewMode === 'string' && VIEW_MODES.includes(view.viewMode) ? view.viewMode : sortKey && 'list';
		if (mode) {
			void this.memento.update(VIEW_MODE_KEY, mode);
			void this.memento.update(SORT_KEY_KEY, sortKey);
		}
		return true;
	}

	private cancelCurrent(reason: string): void {
		if (this.current) {
			this.log.debug(`Stopped moving focus: ${reason}`);
			this.current.cancel();
			this.current = undefined;
		}
	}

	/**
	 * Starts moving focus, cancelling any move still running so a quick second stage wins. The new
	 * move waits for the cancelled one to stop, because a move that has opened a file finishes
	 * opening the click's editor and closes the file's tab again.
	 */
	private startFocus(run: (token: vscode.CancellationToken) => Promise<unknown>): Promise<void> {
		this.current?.cancel();
		const tokenSource = this.current = new vscode.CancellationTokenSource();
		const focus = this.lastFocus.then(async () => {
			try {
				if (!tokenSource.token.isCancellationRequested) {
					await run(tokenSource.token);
				}
			} catch (err) {
				this.log.error(`Moving focus failed: ${err}`);
			} finally {
				if (this.current === tokenSource) {
					this.current = undefined;
				}
				tokenSource.dispose();
			}
		});
		this.lastFocus = focus;
		return focus;
	}

	/**
	 * Runs the stage and unstage commands one at a time. A key press that arrives while the last
	 * one is still staging, or still moving focus, would otherwise act on the row that is moving.
	 * A press waits for the stage to finish, which can take as long as git's prompt about conflict
	 * markers stays open, and then at most PREVIOUS_FOCUS_TIMEOUT for the focus move.
	 */
	runAndFocus(move: Move, args: unknown[]): Promise<void> {
		if (this.waitingPresses >= MAX_WAITING_PRESSES) {
			this.log.debug(`Ignored a key press, because ${this.waitingPresses} are waiting already`);
			return Promise.resolve();
		}
		this.waitingPresses++;
		const previous = this.lastPress;
		let moved = () => { };
		const press = {
			moved: new Promise<void>(resolve => { moved = resolve; }),
			done: previous.moved
				.then(() => Promise.race([previous.done, new Promise(resolve => setTimeout(resolve, PREVIOUS_FOCUS_TIMEOUT))]))
				.then(() => {
					this.waitingPresses--;
					return this.runOneAndFocus(move, args, moved);
				})
				.finally(() => moved()),
		};
		this.lastPress = { moved: press.moved, done: press.done.catch(() => undefined) };
		return press.done;
	}

	/**
	 * Runs git.stage or git.unstage, then moves focus the same way as after the inline buttons.
	 * Calls `staged` once the command has finished.
	 */
	private async runOneAndFocus(move: Move, args: unknown[], staged: () => void): Promise<void> {
		await this.whenReady();
		const command = move === 'stage' ? 'git.stage' : 'git.unstage';
		const repositories = this.git?.api.repositories ?? [];
		const before = new Map(repositories.map(repository => [repository, takeSnapshot(repository)]));
		// A keybinding in Source Control passes the view's layout. From the Command Palette there are
		// no arguments, and the command stages the active editor's file.
		if (this.rememberView(args[0])) {
			await this.openHighlightedRow();
		}
		const resources = this.resourceForActiveEditor(move);
		if (!resources) {
			this.log.debug(`Nothing to ${move}: the active editor's file isn't on that side`);
			return;
		}
		this.commandsRunning++;
		try {
			await vscode.commands.executeCommand(command, ...resources);
		} finally {
			this.commandsRunning--;
			staged();
		}
		await Promise.all([...before].map(([repository, snapshot]) => this.onMoved(move, repository, snapshot, 'command')));
	}

	/**
	 * git.stage and git.unstage act on the editor's file, which isn't the highlighted row after
	 * moving with the arrow keys. A keybinding in Source Control passes the view mode, so when it
	 * does, open the highlighted row first, as Space does. The README's `when` clause keeps the
	 * key off folder rows, because opening one would collapse it.
	 *
	 * When every git row opens straight away, the editor is open by the time a round trip to the
	 * window returns, and an unchanged active tab means the row was already open. Otherwise the
	 * extension can't tell a row that is still opening from one that was already open, so it waits.
	 */
	private async openHighlightedRow(): Promise<void> {
		const before = activeTabKey();
		const started = Date.now();
		await vscode.commands.executeCommand('list.selectAndPreserveFocus');
		await roundTrip();
		let changed = activeTabChangedFrom(before);
		const waited = !changed && !this.rowsOpenStraightAway();
		if (waited) {
			changed = await waitForActiveTabChange(before, HIGHLIGHT_OPEN_TIMEOUT);
		}
		const took = `${Date.now() - started}ms${waited ? ', waiting for it' : ''}`;
		this.log.debug(changed ? `Opened the highlighted row in ${took}` : `The highlighted row was already open (${took})`);
	}

	private rowsOpenStraightAway(): boolean {
		const repositories = this.git?.model?.repositories.filter(isInternalRepository);
		return !!repositories && repositories.every(repository =>
			[repository.mergeGroup, repository.indexGroup, repository.workingTreeGroup, repository.untrackedGroup]
				.every(group => group.resourceStates.every(resource => opensStraightAway(resource.command))));
	}

	/**
	 * A command can run before the extension has connected to the git extension, for example when
	 * the first key press after a restart activates it. Waits for that, but not for git to be
	 * turned on, which may never happen.
	 */
	private whenReady(): Promise<unknown> {
		return Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
	}

	/**
	 * With no arguments, git.stage and git.unstage work on the active editor's file, but look it up
	 * in Changes, then Staged Changes, then Merge Changes, and never in Untracked Changes. So
	 * unstaging a file that also has unstaged changes does nothing, and staging an untracked file
	 * does nothing when git.untrackedChanges is "separate". Passing the git extension's own
	 * resource for the right group avoids both.
	 *
	 * Returns undefined when the active tab's file is in a repository but not on the side `move`
	 * takes files from, so there is nothing to do. git.stage would look up the active text editor
	 * instead, which can still be the file opened before the highlighted row.
	 */
	private resourceForActiveEditor(move: Move): InternalResource[] | undefined {
		const file = activeTabFile();
		const model = this.git?.model;
		if (!file || !model) {
			return [];
		}
		const internal = model.repositories
			.filter(repository => isInternalRepository(repository) && isInside(file, repository.root))
			.sort((a, b) => b.root.length - a.root.length)[0];
		if (!internal) {
			return [];
		}
		const groups = move === 'unstage'
			? [internal.indexGroup]
			: [internal.workingTreeGroup, internal.untrackedGroup, internal.mergeGroup];
		const key = pathKey(file);
		for (const group of groups) {
			const resource = group.resourceStates.find(r => pathKey(r.resourceUri.fsPath) === key);
			if (resource) {
				return [resource];
			}
		}
		return undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.current?.cancel();
		this.disposables.forEach(d => d.dispose());
		this.watched.forEach(listeners => listeners.forEach(d => d.dispose()));
		this.watched.clear();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Focus Next on Stage', { log: true });
	const controller = new Controller(log, context.workspaceState);
	context.subscriptions.push(
		log,
		controller,
		vscode.commands.registerCommand('focusNextOnStage.stage', (...args: unknown[]) => controller.runAndFocus('stage', args)),
		vscode.commands.registerCommand('focusNextOnStage.unstage', (...args: unknown[]) => controller.runAndFocus('unstage', args)),
	);
}

export function deactivate(): void { }

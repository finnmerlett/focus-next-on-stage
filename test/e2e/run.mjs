// End-to-end tests: one isolated VS Code window with the extension loaded, driven like a user.
// Run with `npm run test:e2e`. Set FLN_ONLY=<substring> to run matching scenarios only, with | between alternatives.
import { createDriver, repoTools } from './driver.mjs';
import { launch, sleep, waitFor, PROJECT } from './harness.mjs';

const FILES = {
	'a.txt': 'a\n', 'b.txt': 'b\n', 'src/c.ts': 'c\n', 'src/deep/d.ts': 'd\n', 'docs/e.md': 'e\n',
	'lib/w.ts': 'w\n', 'z/y/x.ts': 'x\n',
	// Not a real image, but VS Code picks the image editor by the extension.
	'p.png': 'p\n',
};
const ALL = Object.keys(FILES);
// Enough files for the Source Control list to scroll, for the scroll scenario only.
const pad = n => String(n).padStart(2, '0');
const MANY_STAGED = Array.from({ length: 25 }, (_, i) => `many/f${pad(i + 1)}.txt`);
const MANY_UNSTAGED = Array.from({ length: 25 }, (_, i) => `big/g${pad(i + 1)}.txt`);
for (const f of [...MANY_STAGED, ...MANY_UNSTAGED]) FILES[f] = `${f}\n`;

// The keybindings from the README, plus its entries for list view sorted by name or status.
const SCM = "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild";
// Later entries win when several match, so the list entries with a sort order come last.
const viewKeys = (key, command) => [
	{ key, command, args: { viewMode: 'tree' }, when: `${SCM} && scmViewMode == 'tree'` },
	{ key, command, args: { viewMode: 'list' }, when: `${SCM} && scmViewMode == 'list'` },
	...['name', 'status'].map(viewSortKey =>
		({ key, command, args: { viewMode: 'list', viewSortKey }, when: `${SCM} && scmViewMode == 'list' && scmViewSortKey == '${viewSortKey}'` })),
];

const vs = await launch({
	repo: { files: FILES },
	settings: { 'scm.defaultViewMode': 'tree', 'window.dialogStyle': 'custom' },
	keybindings: [
		...viewKeys('s', 'focusNextOnStage.stage'), ...viewKeys('shift+s', 'focusNextOnStage.unstage'),
		// A binding that passes only a sort order, as 0.3.0's README suggested.
		{ key: 'n', command: 'focusNextOnStage.stage', args: { viewSortKey: 'name' }, when: `${SCM} && scmViewMode == 'list'` },
	],
	extensions: [PROJECT],
	port: 9340, bridgePort: 9440,
});
const { cdp, bridge } = vs;
const { state, setting, command, clickRow, clickAction, dialogButton, clickDialogButton, expectFocus, expectStable, scenario, summary, extensionLog, rowTop, scrollTreeTo } = createDriver(vs);
const repo = repoTools(vs.repoDir, FILES);

/**
 * Closes every editor. Merge editors with unhandled conflicts ask before closing, and VS Code asks
 * again after each `Close with Conflicts`, so this ticks "Do not ask me again" for the rest of the
 * run. A merge editor that opened a file with conflict markers has unsaved changes, and asks
 * whether to save them. An open dialog would block every later command.
 */
async function closeAllEditors() {
	let closed = false;
	const closing = command('workbench.action.closeAllEditors').then(() => { closed = true; });
	await waitFor(async () => {
		if (closed) return true;
		if (await dialogButton('Close with Conflicts')) {
			await cdp.evaluate(`document.querySelector('.monaco-dialog-box [aria-label="Do not ask me again"]').click()`);
			await clickDialogButton('Close with Conflicts');
		} else if (await dialogButton('Don\'t Save')) {
			await clickDialogButton('Don\'t Save');
		}
		return false;
	}, { what: 'the editors to close' });
	await closing;
}

/** Resets the repo (see repoTools.reset) and waits for the view to show it with every folder expanded. */
async function arrange(spec) {
	await closeAllEditors();
	const expected = repo.reset(spec);
	await bridge('await git.repositories[0].status(); return true');
	await waitFor(() => bridge(`const s = git.repositories[0].state; return s.mergeChanges.length + s.indexChanges.length + s.workingTreeChanges.length + s.untrackedChanges.length === ${expected}`),
		{ what: 'git to report the arranged changes', timeout: 10000 });
	await waitFor(async () => {
		const s = await state();
		const collapsed = s.rows.find(r => r.expanded === 'false');
		if (!collapsed) return true;
		await clickRow(collapsed.label);
		return false;
	}, { what: 'folders to expand', timeout: 10000 });
	await sleep(400);
}

const staged = async () => bridge('return git.repositories[0].state.indexChanges.map(c => vscode.workspace.asRelativePath(c.uri)).sort()');
/** The labels of the open tabs, one array per editor group. */
const tabLabels = () => bridge('return vscode.window.tabGroups.all.map(g => g.tabs.map(t => t.label))');
/** Waits until `check` passes for the open tabs, then fails with the tabs if it never does. */
async function expectTabs(check, what) {
	await waitFor(async () => check(await tabLabels()), { what, timeout: 2000 })
		.catch(async () => { throw new Error(`expected ${what}, open tabs: ${JSON.stringify(await tabLabels())}`); });
}
const file = name => JSON.stringify(`${vs.repoDir}/${name}`);

/** Runs `fn` with a setting changed, then puts it back. */
async function withSetting(key, value, fn) {
	await setting(key, value);
	try {
		await fn();
	} finally {
		await setting(key, undefined);
	}
}

// Open the Source Control view.
await cdp.key('g', 2 | 8);
await sleep(1500);

// Tree order with folders first: docs/e.md, lib/w.ts, src/deep/d.ts, src/c.ts, z/y/x.ts, a.txt, b.txt

await scenario('s stages the open file, then focuses and opens the file below it', async () => {
	await arrange({ modified: ALL });
	await clickRow('d.ts, Modified, src/deep');
	const pressed = Date.now();
	await cdp.key('s');
	await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
	console.log(`     focus and editor moved within ${Date.now() - pressed}ms of pressing s`);
	if (!(await staged()).includes('src/deep/d.ts')) throw new Error('d.ts was not staged');
});

await scenario('the file below can be in the next folder', async () => {
	await arrange({ modified: ALL });
	await clickRow('c.ts, Modified, src');
	await cdp.key('s');
	await expectFocus({ row: 'x.ts, Modified, z/y', tab: 'x.ts (Working Tree)' });
});

await scenario('staging the last file focuses the one above', async () => {
	await arrange({ modified: ['a.txt', 'b.txt'] });
	await clickRow('b.txt, Modified');
	await cdp.key('s');
	await expectFocus({ row: 'a.txt, Modified', tab: 'a.txt (Working Tree)' });
});

await scenario('s stages the highlighted row after moving with the arrow keys', async () => {
	await arrange({ modified: ALL });
	await clickRow('e.md, Modified, docs');   // opens e.md
	for (let i = 0; i < 5; i++) await cdp.key('ArrowDown');   // lib, w.ts, src, deep, d.ts
	await waitFor(async () => (await state()).focused === 'd.ts, Modified, src/deep', { what: 'highlight on d.ts' });
	await cdp.key('s');
	await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
	const files = await staged();
	if (!files.includes('src/deep/d.ts') || files.includes('docs/e.md')) throw new Error(`staged ${files}, expected src/deep/d.ts only`);
});

await scenario('with git.openDiffOnClick off, s stages the highlighted row after moving with the arrow keys', () => withSetting('git.openDiffOnClick', false, async () => {
	// The row opens through a slower path, and replacing the preview tab sends several tab updates.
	await arrange({ modified: ['a.txt', 'b.txt'] });
	await clickRow('a.txt, Modified');   // opens a.txt itself
	await cdp.key('ArrowDown');
	await waitFor(async () => (await state()).focused === 'b.txt, Modified', { what: 'highlight on b.txt' });
	await cdp.key('s');
	await expectFocus({ row: 'a.txt, Modified', tab: 'a.txt' });
	const files = await staged();
	if (files.join() !== 'b.txt') throw new Error(`staged ${files}, expected b.txt`);
}));

await scenario('s on a folder row does nothing and leaves it expanded', async () => {
	await arrange({ modified: ALL });
	await clickRow('e.md, Modified, docs');
	await cdp.key('ArrowDown');   // lib folder
	await waitFor(async () => (await state()).focused === 'lib', { what: 'highlight on lib' });
	await cdp.key('s');
	await sleep(1000);
	const s = await state();
	if ((await staged()).length) throw new Error(`staged ${await staged()}`);
	if (s.rows.find(r => r.label === 'lib')?.expanded !== 'true') throw new Error('lib was collapsed');
});

await scenario('the inline + focuses the file below the clicked row', async () => {
	await arrange({ modified: ALL });
	await clickRow('a.txt, Modified');
	await clickAction('w.ts, Modified, lib', 'Stage Changes');
	await expectFocus({ row: 'd.ts, Modified, src/deep', tab: 'd.ts (Working Tree)' });
});

await scenario('a next file inside a collapsed folder is revealed without collapsing anything', async () => {
	await arrange({ modified: ALL });
	await clickRow('z/y');            // collapse z/y, which holds the file below c.ts
	await clickRow('docs');           // collapse docs, which should stay collapsed
	await clickAction('c.ts, Modified, src', 'Stage Changes');
	await expectFocus({ row: 'x.ts, Modified, z/y', tab: 'x.ts (Working Tree)' });
	const s = await state();
	if (s.rows.find(r => r.label === 'docs')?.expanded !== 'false') throw new Error('docs should still be collapsed');
});

await scenario('the inline + is followed after editing the file in a normal tab', async () => {
	await arrange({ modified: ALL });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(vs.repoDir)} + '/a.txt'), { preview: false }); return true`);
	await clickAction('a.txt, Modified', 'Stage Changes');
	await expectFocus({ row: 'b.txt, Modified', tab: 'b.txt (Working Tree)' });
});

await scenario('shift+s focuses the staged file below, then the one above at the end', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt', 'docs/e.md', 'lib/w.ts'] });
	// Staged tree order: docs/e.md, lib/w.ts, a.txt, b.txt
	await clickRow('w.ts, Index Modified, lib');
	await cdp.key('S', 8);
	await expectFocus({ row: 'a.txt, Index Modified', tab: 'a.txt (Index)' });
	if ((await staged()).includes('lib/w.ts')) throw new Error('w.ts was not unstaged');
	await clickRow('b.txt, Index Modified');
	await cdp.key('S', 8);
	await expectFocus({ row: 'a.txt, Index Modified', tab: 'a.txt (Index)' });
});

await scenario('the inline unstage button reveals the staged file below inside a collapsed folder', async () => {
	await arrange({ modified: ['a.txt'], staged: ['lib/w.ts', 'z/y/x.ts', 'b.txt'] });
	await clickRow('z/y');            // collapse z/y in Staged Changes
	await clickAction('w.ts, Index Modified, lib', 'Unstage Changes');
	await expectFocus({ row: 'x.ts, Index Modified, z/y', tab: 'x.ts (Index)' });
});

await scenario('a partly staged file is passed over after an unstage', async () => {
	// scm.autoReveal can only select the Changes row of a file that is in both groups.
	await arrange({ modified: ['src/c.ts'], staged: ['lib/w.ts', 'b.txt'], partial: ['a.txt'] });
	await clickAction('w.ts, Index Modified, lib', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
});

await scenario('a partly staged file can be unstaged with shift+s from its staged diff', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['lib/w.ts', 'b.txt'], partial: ['a.txt'] });
	await clickRow('a.txt, Index Modified');
	await cdp.key('S', 8);
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	if ((await staged()).includes('a.txt')) throw new Error('a.txt is still staged');
});

await scenario('with git.openDiffOnClick off, the staged file below opens as the file itself', () => withSetting('git.openDiffOnClick', false, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt' });
}));

await scenario('staging the last unstaged file focuses the commit message box', async () => {
	await arrange({ modified: ['a.txt'], staged: ['b.txt'] });
	await clickRow('a.txt, Modified');
	await cdp.key('s');
	await expectFocus({ dom: 'input' });
});

await scenario('whenAllStaged lowestStaged focuses the last staged file instead', () => withSetting('focusNextOnStage.whenAllStaged', 'lowestStaged', async () => {
	await arrange({ modified: ['a.txt'], staged: ['b.txt', 'lib/w.ts'] });
	await clickAction('a.txt, Modified', 'Stage Changes');
	// Staged tree order: lib/w.ts, a.txt, b.txt
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
}));

await scenario('unstaging the last staged file focuses the top unstaged file', async () => {
	await arrange({ modified: ['a.txt', 'src/c.ts'], staged: ['b.txt'] });
	await clickAction('b.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
});

await scenario('the top unstaged file can be the one just unstaged', async () => {
	// The view gets the new groups 100ms after git, so this waits before revealing a.txt.
	await arrange({ modified: ['b.txt'], staged: ['a.txt'] });
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'a.txt, Modified', tab: 'a.txt (Working Tree)' });
});

await scenario('when only partly staged files are left after an unstage, the top unstaged file is focused', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['b.txt'], partial: ['a.txt'] });
	await clickAction('b.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
});

await scenario('with previews off, focusing a staged file leaves no extra tab', () => withSetting('workbench.editor.enablePreview', false, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	// The extension closes the plain b.txt tab just after the diff opens.
	const labels = () => bridge('return vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label)');
	await waitFor(async () => !(await labels()).includes('b.txt'), { what: 'only b.txt (Index) open', timeout: 2000 })
		.catch(async () => { throw new Error(`open tabs: ${(await labels()).join(', ')}`); });
}));

await scenario('with previews off, focusing a diff that is already open leaves no extra tab', () => withSetting('workbench.editor.enablePreview', false, async () => {
	await arrange({ modified: ['a.txt', 'b.txt'] });
	await clickRow('b.txt, Modified');
	await clickAction('a.txt, Modified', 'Stage Changes');
	await expectFocus({ row: 'b.txt, Modified', tab: 'b.txt (Working Tree)' });
	const labels = () => bridge('return vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label)');
	await waitFor(async () => !(await labels()).includes('b.txt'), { what: 'only b.txt (Working Tree) open', timeout: 2000 })
		.catch(async () => { throw new Error(`open tabs: ${(await labels()).join(', ')}`); });
}));

await scenario('a staged diff is focused when the file itself is the active editor', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(vs.repoDir)} + '/b.txt'), { preview: false }); return true`);
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	// The extension only closes a tab it added, so the b.txt tab opened above stays.
	await sleep(500);
	await expectTabs(groups => groups[0].includes('b.txt'), 'the b.txt tab still open');
});

await scenario('focusing a pinned diff that is already active keeps the preview tab of another file', async () => {
	await arrange({ modified: ['a.txt', 'b.txt'] });
	await clickRow('b.txt, Modified');
	await command('workbench.action.keepEditor');
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { preview: true, preserveFocus: true }); return true`);
	await clickRow('b.txt, Modified');   // makes the pinned diff active again
	await expectTabs(groups => groups[0].join() === 'b.txt (Working Tree),e.md', 'the pinned diff and the e.md preview');
	await clickAction('a.txt, Modified', 'Stage Changes');
	await expectFocus({ row: 'b.txt, Modified', tab: 'b.txt (Working Tree)' });
	await sleep(500);
	await expectTabs(groups => groups[0].join() === 'b.txt (Working Tree),e.md', 'the e.md preview still open and no b.txt tab');
});

await scenario('with previews off, focusing a staged file open in another group leaves no extra tab', () => withSetting('workbench.editor.enablePreview', false, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('b.txt')}), { viewColumn: 2, preserveFocus: true }); return true`);
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { viewColumn: 1, preserveFocus: true }); return true`);
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	await expectTabs(groups => groups[0].join() === 'e.md,b.txt (Index)' && groups[1].join() === 'b.txt', 'no plain b.txt tab in the first group');
}));

await scenario('with revealIfOpen on, the next staged diff opens in the active group, as a click on its row would', () => withSetting('workbench.editor.revealIfOpen', true, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('b.txt')}), { viewColumn: 2, preserveFocus: true }); return true`);
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { viewColumn: 1, preserveFocus: true }); return true`);
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	await expectTabs(groups => groups[0].join() === 'b.txt (Index)' && groups[1].join() === 'b.txt', 'the diff in the first group and b.txt alone in the second');
}));

await scenario('with previews off, focusing a staged image leaves no extra tab', () => withSetting('workbench.editor.enablePreview', false, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'p.png'] });
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await expectFocus({ row: 'p.png, Index Modified', tab: 'p.png (Index)' });
	await expectTabs(groups => groups.flat().join() === 'p.png (Index)', 'only p.png (Index) open');
}));

await scenario('a stage from the multi-file diff editor leaves it open', async () => {
	await arrange({ modified: ['a.txt', 'b.txt', 'src/c.ts'] });
	const multiDiffActive = () => bridge('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return !!t && t.input instanceof vscode.TabInputTextMultiDiff');
	await command('git.viewChanges');
	await waitFor(multiDiffActive, { what: 'the multi-file diff editor' });
	await bridge(`await git.repositories[0].add([${JSON.stringify(vs.repoDir + '/a.txt')}]); return true`);
	await waitFor(async () => (await staged()).includes('a.txt'), { what: 'a.txt staged' });
	await sleep(1000);
	if (!(await multiDiffActive())) {
		throw new Error(`the active tab is ${await bridge('return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null')}`);
	}
});

await scenario('whenAllUnstaged none leaves focus alone', () => withSetting('focusNextOnStage.whenAllUnstaged', 'none', async () => {
	await arrange({ modified: ['a.txt', 'src/c.ts'], staged: ['b.txt'] });
	await clickRow('a.txt, Modified');
	const before = await state();
	await clickAction('b.txt, Index Modified', 'Unstage Changes');
	await waitFor(async () => !(await staged()).length, { what: 'b.txt unstaged' });
	await expectStable(before);
}));

await scenario('an untracked file below is focused like any other', async () => {
	await arrange({ modified: ['src/c.ts', 'a.txt'], untracked: ['src/new.ts'] });
	// Tree order: src/c.ts, src/new.ts, a.txt
	await clickAction('c.ts, Modified, src', 'Stage Changes');
	await expectFocus({ row: 'new.ts, Untracked, src', tab: 'new.ts' });
});

await scenario('with untracked files in their own group, s moves from Changes into it', () => withSetting('git.untrackedChanges', 'separate', async () => {
	await arrange({ modified: ['b.txt', 'a.txt'], untracked: ['src/new.ts', 'n.txt'] });
	await clickRow('b.txt, Modified');
	await cdp.key('s');
	await expectFocus({ row: 'new.ts, Untracked, src', tab: 'new.ts' });
	// git.stage with no arguments skips Untracked Changes; s passes the resource itself.
	await cdp.key('s');
	await expectFocus({ row: 'n.txt, Untracked', tab: 'n.txt' });
	if (!(await staged()).includes('src/new.ts')) throw new Error('new.ts was not staged by s');
}));

await scenario('a deleted file below opens like a click', async () => {
	await arrange({ modified: ['a.txt'], deleted: ['b.txt'] });
	await clickAction('a.txt, Modified', 'Stage Changes');
	await expectFocus({ row: 'b.txt, Deleted', tab: 'b.txt (Deleted)' });
});

await scenario('with nothing below, focus can move up into Merge Changes', async () => {
	await arrange({ conflicts: ['a.txt'], modified: ['src/c.ts'] });
	const conflictRow = (await state()).rows.find(r => r.label.startsWith('a.txt, '))?.label;
	await clickAction('c.ts, Modified, src', 'Stage Changes');
	await expectFocus({ row: conflictRow, tab: 'a.txt' });
});

await scenario('resolving a deletion conflict with Delete File moves to the next file', async () => {
	await arrange({ deletedByThem: ['docs/e.md'], modified: ['b.txt'] });
	const conflictRow = (await state()).rows.find(r => r.label.startsWith('e.md, '))?.label;
	await clickAction(conflictRow, 'Stage Changes');
	await clickDialogButton('Delete File');
	await expectFocus({ row: 'b.txt, Modified', tab: 'b.txt (Working Tree)' });
});

await scenario('staging the deleted half of a rename moves to the next file', async () => {
	// Unstaging the deletion of x.ts leaves v.ts staged as added and x.ts deleted in Changes.
	await arrange({ modified: ['a.txt', 'b.txt'], renamed: [['z/y/x.ts', 'z/y/v.ts']] });
	repo.git('reset', '-q', '--', 'z/y/x.ts');
	await bridge('await git.repositories[0].status(); return true');
	const row = (await waitFor(async () => (await state()).rows.find(r => r.label.startsWith('x.ts, Deleted')), { what: 'the deleted row' })).label;
	await sleep(400);
	await clickAction(row, 'Stage Changes');
	await expectFocus({ row: 'a.txt, Modified', tab: 'a.txt (Working Tree)' });
});

await scenario('a staged rename can be the file above', async () => {
	await arrange({ modified: ['a.txt'], staged: ['b.txt'], renamed: [['z/y/x.ts', 'z/y/v.ts']] });
	// Staged tree order: z/y/v.ts (folder first), b.txt.
	await clickAction('b.txt, Index Modified', 'Unstage Changes');
	const row = (await waitFor(async () => (await state()).rows.find(r => r.label.startsWith('v.ts, Index Renamed')), { what: 'rename row' })).label;
	await expectFocus({ row, tab: 'v.ts (Index)' });
});

for (const how of ['the inline button', 'shift+s']) {
	await scenario(`unstaging a staged rename with ${how} focuses the deletion it leaves staged`, async () => {
		// git reset on the new path v.ts leaves the deletion of x.ts staged, in a row that wasn't there before.
		await arrange({ modified: ['a.txt'], staged: ['b.txt'], renamed: [['z/y/x.ts', 'z/y/v.ts']] });
		const rename = (await waitFor(async () => (await state()).rows.find(r => r.label.startsWith('v.ts, Index Renamed')), { what: 'rename row' })).label;
		if (how === 'shift+s') {
			await clickRow(rename);
			await cdp.key('S', 8);
		} else {
			await clickRow('a.txt, Modified');
			await clickAction(rename, 'Unstage Changes');
		}
		await expectFocus({ row: 'x.ts, Index Deleted, z/y', tab: 'x.ts (Deleted)' });
	});
}

await scenario('a merge editor that is already active has its row focused', () => withSetting('git.mergeEditor', true, async () => {
	await arrange({ conflicts: ['a.txt', 'b.txt'], modified: ['src/c.ts'] });
	// Without conflict markers, git stages the files without asking.
	repo.write('a.txt', 'resolved\n');
	repo.write('b.txt', 'resolved\n');
	const row = async name => (await waitFor(async () => (await state()).rows.find(r => r.label.startsWith(`${name}, `)), { what: `${name} conflict row` })).label;
	await clickRow(await row('b.txt'));
	await waitFor(async () => (await bridge('return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null'))?.includes('b.txt'), { what: 'the b.txt merge editor' });
	const mergeTab = await bridge('return vscode.window.tabGroups.activeTabGroup.activeTab.label');
	// Move the highlight off b.txt, so only the extension can focus its row again.
	const aRow = await row('a.txt');
	await cdp.key('ArrowUp');
	await waitFor(async () => (await state()).focused === aRow, { what: 'highlight on a.txt' });
	await clickAction(aRow, 'Stage Changes');
	await expectFocus({ row: await row('b.txt'), tab: mergeTab });
}));

await scenario('s stages the highlighted merge conflict after moving with the arrow keys', () => withSetting('git.mergeEditor', true, async () => {
	await arrange({ conflicts: ['a.txt', 'b.txt'], modified: ['src/c.ts'] });
	repo.write('a.txt', 'resolved\n');
	repo.write('b.txt', 'resolved\n');
	const row = async name => (await waitFor(async () => (await state()).rows.find(r => r.label.startsWith(`${name}, `)), { what: `${name} conflict row` })).label;
	await clickRow(await row('a.txt'));
	await cdp.key('ArrowDown');
	const bRow = await row('b.txt');
	await waitFor(async () => (await state()).focused === bRow, { what: 'highlight on b.txt' });
	await cdp.key('s');
	await waitFor(async () => (await staged()).length > 0, { what: 'a stage' });
	await sleep(500);
	const files = await staged();
	if (files.join() !== 'b.txt') throw new Error(`staged ${files}, expected b.txt`);
}));

const activeTabLabel = () => bridge('return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null');
/** Presses ArrowUp until `label` is the highlighted row. */
async function arrowUpTo(label) {
	for (let i = 0; i < 4 && (await state()).focused !== label; i++) {
		await cdp.key('ArrowUp');
		await sleep(100);
	}
	await waitFor(async () => (await state()).focused === label, { what: `highlight on ${label}` });
}

await scenario('shift+s on a merge conflict doesn\'t unstage the staged file that was open before', () => withSetting('git.mergeEditor', true, async () => {
	await arrange({ conflicts: ['a.txt'], staged: ['b.txt'] });
	await clickRow('b.txt, Index Modified');
	await waitFor(async () => (await activeTabLabel())?.includes('b.txt'), { what: 'the b.txt staged diff' });
	await arrowUpTo((await state()).rows.find(r => r.label.startsWith('a.txt, ')).label);
	await cdp.key('S', 8);
	// The merge editor opens through the git extension, so the key press waits for it.
	await waitFor(async () => !(await activeTabLabel())?.includes('b.txt'), { what: 'the a.txt merge editor' });
	await sleep(800);
	const files = await staged();
	if (files.join() !== 'b.txt') throw new Error(`staged ${files}, expected b.txt`);
}));

await scenario('a second press while git asks about conflict markers waits, then stages the next file', () => withSetting('git.mergeEditor', true, async () => {
	await arrange({ conflicts: ['a.txt'], modified: ['b.txt'] });
	await clickRow((await state()).rows.find(r => r.label.startsWith('a.txt, ')).label);
	await waitFor(async () => (await activeTabLabel())?.includes('a.txt'), { what: 'the a.txt merge editor' });
	// The first press waits for the merge editor before staging, so the second one queues.
	await cdp.key('s');
	await sleep(60);
	await cdp.key('s');
	await waitFor(() => dialogButton('Yes'), { what: 'the conflict markers prompt' });
	// Longer than the second press waits for the focus move of the first.
	await sleep(2000);
	await clickDialogButton('Yes');
	await waitFor(async () => (await staged()).join() === 'a.txt,b.txt', { what: 'a.txt and b.txt staged', timeout: 5000 })
		.catch(async () => { throw new Error(`staged ${await staged()}, expected a.txt and b.txt`); });
	const dialog = await cdp.evaluate(`document.querySelector('.monaco-dialog-box')?.innerText ?? null`);
	if (dialog) throw new Error(`a dialog is open: ${dialog.replace(/\s+/g, ' ')}`);
}));

await scenario('the next file opens outside a locked editor group, as a click on its row would', async () => {
	await arrange({ modified: ['a.txt', 'b.txt', 'src/c.ts'] });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { viewColumn: 1, preserveFocus: true }); return true`);
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('lib/w.ts')}), { viewColumn: 2 }); return true`);
	// Like a terminal in the editor area, which VS Code locks its group for.
	await command('workbench.action.lockEditorGroup');
	try {
		await clickAction('a.txt, Modified', 'Stage Changes');
		await expectFocus({ row: 'b.txt, Modified', tab: 'b.txt (Working Tree)' });
		await expectTabs(groups => groups.length === 2 && groups[0].includes('b.txt (Working Tree)') && groups[1].join() === 'w.ts', 'b.txt in the first group');
	} finally {
		await command('workbench.action.focusSecondEditorGroup');
		await command('workbench.action.unlockEditorGroup');
	}
});

await scenario('with an editor limit, focusing a staged file doesn\'t close another tab', () => withSetting('workbench.editor.limit.enabled', true, () => withSetting('workbench.editor.limit.value', 3, async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { preview: false, preserveFocus: true }); return true`);
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('lib/w.ts')}), { preview: false, preserveFocus: true }); return true`);
	await clickRow('a.txt, Index Modified');
	await expectTabs(groups => groups.flat().join() === 'e.md,w.ts,a.txt (Index)', 'three tabs');
	await cdp.key('S', 8);
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	await expectTabs(groups => groups.flat().join() === 'e.md,w.ts,b.txt (Index)', 'e.md and w.ts still open');
})));

/**
 * Waits for the extension's debug log to show the focus move to `name` after `logBefore`, and
 * returns the log lines from then. Use it when the row can be highlighted before the move ends,
 * for example because the list moved the highlight there when the row above went.
 */
async function moveLog(logBefore, name) {
	return waitFor(() => {
		const lines = extensionLog().slice(logBefore).split('\n');
		return lines.some(line => /\] (Focused|Opened) /.test(line) && line.includes(name)) && lines;
	}, { what: `the focus move to ${name} in the debug log` });
}

await scenario('a staged diff that is already the active editor has its row focused straight away', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'b.txt'] });
	await clickRow('b.txt, Index Modified');
	await waitFor(async () => (await activeTabLabel()) === 'b.txt (Index)', { what: 'the b.txt staged diff' });
	const logBefore = extensionLog().length;
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	const lines = await moveLog(logBefore, 'b.txt');
	await expectFocus({ row: 'b.txt, Index Modified', tab: 'b.txt (Index)' });
	const time = line => Date.parse(line.slice(0, 23).replace(' ', 'T'));
	const took = time(lines.find(line => line.includes('] Focused'))) - time(lines.find(line => line.includes('focusing next')));
	if (took > 500) throw new Error(`the focus move took ${took} ms`);
});

await scenario('focusing a pinned image diff keeps the preview tab of another file', async () => {
	await arrange({ modified: ['src/c.ts'], staged: ['a.txt', 'p.png'] });
	await clickRow('p.png, Index Modified');
	await waitFor(async () => (await activeTabLabel()) === 'p.png (Index)', { what: 'the p.png staged diff' });
	await command('workbench.action.keepEditor');
	await bridge(`await vscode.window.showTextDocument(vscode.Uri.file(${file('docs/e.md')}), { preview: true, preserveFocus: true }); return true`);
	await expectTabs(groups => groups.flat().join() === 'p.png (Index),e.md', 'the pinned diff and e.md');
	const logBefore = extensionLog().length;
	await clickAction('a.txt, Index Modified', 'Unstage Changes');
	await moveLog(logBefore, 'p.png');
	await expectFocus({ row: 'p.png, Index Modified', tab: 'p.png (Index)' });
	await expectTabs(groups => groups.flat().join() === 'p.png (Index),e.md', 'e.md still open');
});

await scenario('a binding that passes only a sort order uses it and stages the highlighted row', async () => {
	await command('workbench.scm.action.setListViewMode');
	try {
		// A plain list press first, which clears any sort order kept from before.
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
		await command('workbench.scm.action.setSortKey.name');
		await arrange({ modified: ALL });
		// By name: a.txt, b.txt, c.ts, d.ts, e.md, ... By path, p.png would follow b.txt.
		await clickRow('a.txt, Modified');
		await cdp.key('ArrowDown');
		await waitFor(async () => (await state()).focused === 'b.txt, Modified', { what: 'highlight on b.txt' });
		await cdp.key('n');
		await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
		const files = await staged();
		if (files.join() !== 'b.txt') throw new Error(`staged ${files}, expected b.txt`);
	} finally {
		await command('workbench.scm.action.setSortKey.path');
		await command('workbench.scm.action.setTreeViewMode');
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
	}
});

await scenario('without the git extension\'s internal repository, s stages and focus stays in the list', async () => {
	await arrange({ modified: ['a.txt', 'b.txt'] });
	await clickRow('a.txt, Modified');
	// isInternalRepository then fails, as it would if a VS Code update changed the shape.
	const cleared = await bridge('const r = vscode.extensions.getExtension("vscode.git").exports.model.repositories[0]; r.__onRunOperation = r.onRunOperation; r.onRunOperation = undefined; return typeof r.onRunOperation');
	try {
		if (cleared !== 'undefined') throw new Error(`couldn't clear onRunOperation: ${cleared}`);
		await cdp.key('s');
		await waitFor(async () => (await staged()).includes('a.txt'), { what: 'a.txt staged' });
		await sleep(800);
		const s = await state();
		if (s.domFocusInScmInput || !s.domFocusInScmTree) throw new Error(`keyboard focus moved: tree=${s.domFocusInScmTree} input=${s.domFocusInScmInput}`);
	} finally {
		await bridge('const r = vscode.extensions.getExtension("vscode.git").exports.model.repositories[0]; r.onRunOperation = r.__onRunOperation; delete r.__onRunOperation; return true');
	}
});

await scenario('Stage All Changes focuses the commit message box', async () => {
	await arrange({ modified: ['a.txt', 'b.txt', 'src/c.ts'] });
	await clickAction('Changes', 'Stage All Changes');
	await expectFocus({ dom: 'input' });
});

await scenario('git add from outside VS Code does not move focus', async () => {
	await arrange({ modified: ALL });
	await clickRow('b.txt, Modified');
	const before = await state();
	repo.git('add', '--', 'a.txt');
	await bridge('await git.repositories[0].status(); return true');
	await waitFor(async () => (await state()).rows.some(r => r.label === 'a.txt, Index Modified'), { what: 'a.txt staged' });
	await expectStable(before);
});

// The second press waits for the first to finish moving focus, then stages the file it moved to.
for (const gaps of [[120], [350, 350]]) {
	await scenario(`presses ${gaps.join(' and ')} ms apart each stage the next file`, async () => {
		await arrange({ modified: ALL });
		await clickRow('e.md, Modified, docs');
		await cdp.key('s');
		for (const gap of gaps) {
			await sleep(gap);
			await cdp.key('s');
		}
		const expected = ['docs/e.md', 'lib/w.ts', 'src/deep/d.ts'].slice(0, gaps.length + 1);
		const last = ['w.ts, Modified, lib', 'd.ts, Modified, src/deep', 'c.ts, Modified, src'][gaps.length];
		await expectFocus({ row: last });
		const files = await staged();
		if (files.join() !== expected.join()) throw new Error(`staged ${files}, expected ${expected}`);
	});
}

await scenario('list view uses the list order the keybinding passes', async () => {
	await command('workbench.scm.action.setListViewMode');
	try {
		await arrange({ modified: ALL });
		// List order by path, with a folder's own files before its subfolders: a.txt, b.txt, p.png,
		// docs/e.md, lib/w.ts, src/c.ts, src/deep/d.ts, z/y/x.ts.
		// In tree order the file after c.ts would be x.ts.
		await clickRow('c.ts, Modified, src');
		await cdp.key('s');
		await expectFocus({ row: 'd.ts, Modified, src/deep', tab: 'd.ts (Working Tree)' });
	} finally {
		await command('workbench.scm.action.setTreeViewMode');
		// Press a key in tree view so the extension stops using the list order.
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
	}
});

await scenario('list view sorted by name uses that order', async () => {
	await command('workbench.scm.action.setListViewMode');
	await command('workbench.scm.action.setSortKey.name');
	try {
		await arrange({ modified: ALL });
		// By name: a.txt, b.txt, c.ts, d.ts, e.md, p.png, w.ts, x.ts. By path, p.png would follow b.txt.
		await clickRow('b.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'c.ts, Modified, src', tab: 'c.ts (Working Tree)' });
	} finally {
		await command('workbench.scm.action.setSortKey.path');
		await command('workbench.scm.action.setTreeViewMode');
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
	}
});

await scenario('stayInFolder keeps focus in the folder after staging its last file', () => withSetting('focusNextOnStage.stayInFolder', true, async () => {
	await arrange({ modified: ALL });
	// Without the setting, the file below c.ts is x.ts in z/y.
	await clickRow('c.ts, Modified, src');
	await cdp.key('s');
	await expectFocus({ row: 'd.ts, Modified, src/deep', tab: 'd.ts (Working Tree)' });
	// src is now empty, so focus leaves it for the file below.
	await cdp.key('s');
	await expectFocus({ row: 'x.ts, Modified, z/y', tab: 'x.ts (Working Tree)' });
}));

await scenario('stayInFolder works the same way after an unstage', () => withSetting('focusNextOnStage.stayInFolder', true, async () => {
	await arrange({ modified: ['a.txt'], staged: ['src/deep/d.ts', 'src/c.ts', 'b.txt'] });
	// Staged tree order: src/deep/d.ts, src/c.ts, b.txt
	await clickAction('c.ts, Index Modified, src', 'Unstage Changes');
	await expectFocus({ row: 'd.ts, Index Modified, src/deep', tab: 'd.ts (Index)' });
}));

await scenario('stayInFolder has no effect in list view', () => withSetting('focusNextOnStage.stayInFolder', true, async () => {
	await command('workbench.scm.action.setListViewMode');
	try {
		await arrange({ modified: ALL });
		// List order by path ends src/c.ts, src/deep/d.ts, z/y/x.ts. Staying in src would pick c.ts.
		await clickRow('d.ts, Modified, src/deep');
		await cdp.key('s');
		await expectFocus({ row: 'x.ts, Modified, z/y', tab: 'x.ts (Working Tree)' });
	} finally {
		await command('workbench.scm.action.setTreeViewMode');
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
	}
}));

await scenario('switching list view back to sorting by path stops using the name order', async () => {
	await command('workbench.scm.action.setListViewMode');
	await command('workbench.scm.action.setSortKey.name');
	try {
		await arrange({ modified: ALL });
		await clickRow('b.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'c.ts, Modified, src' });
		await command('workbench.scm.action.setSortKey.path');
		await arrange({ modified: ALL });
		// By path, p.png follows b.txt. By name, c.ts would.
		await clickRow('b.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'p.png, Modified', tab: 'p.png (Working Tree)' });
	} finally {
		await command('workbench.scm.action.setSortKey.path');
		await command('workbench.scm.action.setTreeViewMode');
		await arrange({ modified: ['a.txt', 'b.txt'] });
		await clickRow('a.txt, Modified');
		await cdp.key('s');
		await expectFocus({ row: 'b.txt, Modified' });
	}
});

await scenario('a visible repository row does not get in the way', () => withSetting('scm.alwaysShowRepositories', true, async () => {
	await arrange({ modified: ALL });
	// The tree is rebuilt when the setting changes; wait for the repository row and the commit button.
	await waitFor(async () => {
		const rows = (await state()).rows.map(r => r.label);
		return rows.includes('repo Git') && rows.some(label => label.includes('Commit'));
	}, { what: 'repository row and commit button', timeout: 10000 });
	await sleep(500);
	await clickAction('c.ts, Modified, src', 'Stage Changes');
	await expectFocus({ row: 'x.ts, Modified, z/y', tab: 'x.ts (Working Tree)' });
}));

await scenario('the list doesn\'t scroll when many files are staged and unstaged', async () => {
	await arrange({ staged: MANY_STAGED, modified: MANY_UNSTAGED });
	await scrollTreeTo('g12.txt, Modified, big');
	await clickRow('g12.txt, Modified, big');
	const before = await rowTop('g12.txt, Modified, big');
	await cdp.key('s');
	await expectFocus({ row: 'g13.txt, Modified, big', tab: 'g13.txt (Working Tree)' });
	const after = await rowTop('g13.txt, Modified, big');
	// Staging g12 adds a big folder row and a file row to Staged Changes above, so g13 may sit up
	// to two rows lower than g12 did. Anything more means the list scrolled.
	if (after === null || Math.abs(after - before) > 3 * 22) {
		throw new Error(`the focused row moved from y=${before} to y=${after}`);
	}
	await cdp.key('s');
	await expectFocus({ row: 'g14.txt, Modified, big', tab: 'g14.txt (Working Tree)' });
	const again = await rowTop('g14.txt, Modified, big');
	if (again === null || Math.abs(again - after) > 2 * 22) {
		throw new Error(`the focused row moved from y=${after} to y=${again}`);
	}
	console.log(`     focused row on screen: g12 at y=${before}, then g13 at y=${after}, then g14 at y=${again}`);
});

await vs.close();
process.exit(summary() ? 0 : 1);

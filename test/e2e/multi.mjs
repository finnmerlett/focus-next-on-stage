// End-to-end tests with two repositories in one folder. Run with `npm run test:e2e:multi`.
import { createDriver, repoTools } from './driver.mjs';
import { launch, sleep, waitFor, PROJECT } from './harness.mjs';

const ALPHA = { 'a1.txt': '1\n', 'a2.txt': '2\n', 'sub/a3.txt': '3\n' };
const BETA = { 'b1.txt': '1\n', 'b2.txt': '2\n', 'sub/b3.txt': '3\n' };

const vs = await launch({
	repos: { alpha: { files: ALPHA }, beta: { files: BETA } },
	settings: { 'scm.defaultViewMode': 'tree' },
	keybindings: [
		{ key: 's', command: 'focusNextOnStage.stage', args: { viewMode: 'tree' }, when: "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild && scmViewMode == 'tree'" },
	],
	extensions: [PROJECT],
	port: 9345, bridgePort: 9445,
});
const { cdp, bridge } = vs;
const { command, clickRow, clickAction, expectFocus, scenario, summary } = createDriver(vs);
const alpha = repoTools(vs.repoDirs.alpha, ALPHA);
const beta = repoTools(vs.repoDirs.beta, BETA);

async function arrange(alphaSpec, betaSpec) {
	const expected = alpha.reset(alphaSpec) + beta.reset(betaSpec);
	await bridge('for (const r of git.repositories) await r.status(); return true');
	await command('workbench.action.closeAllEditors');
	await waitFor(() => bridge(`return git.repositories.reduce((n, r) => n + r.state.mergeChanges.length + r.state.indexChanges.length + r.state.workingTreeChanges.length + r.state.untrackedChanges.length, 0) === ${expected}`),
		{ what: 'git to report the arranged changes', timeout: 10000 });
	await sleep(600);
}

/** The repository row above the row that has keyboard focus. */
const focusedRowRepository = () => cdp.evaluate(`(() => {
	const row = document.activeElement?.closest?.('.monaco-list-row') ?? document.querySelector('.scm-view .monaco-list-row.focused');
	if (!row) return null;
	const rows = [...document.querySelectorAll('.scm-view .monaco-list-row')].sort((a, b) => a.dataset.index - b.dataset.index);
	const index = rows.indexOf(row);
	return rows.slice(0, index + 1).reverse().find(r => r.getAttribute('aria-level') === '1')?.getAttribute('aria-label') ?? null;
})()`);

await cdp.key('g', 2 | 8);
await sleep(1500);
// The Graph view below Changes would push rows out of sight.
await command('workbench.scm.history.toggleVisibility');
await sleep(500);

const all = files => Object.keys(files);
// Tree order in each repository: sub/x3.txt, x1.txt, x2.txt

await scenario('staging in one repository after opening a file in the other focuses the file below', async () => {
	await arrange({ modified: all(ALPHA) }, { modified: all(BETA) });
	await clickRow('a2.txt, Modified, alpha');
	await clickAction('b1.txt, Modified, beta', 'Stage Changes');
	await expectFocus({ row: 'b2.txt, Modified, beta', tab: 'b2.txt (Working Tree)' });
	const repository = await focusedRowRepository();
	if (!repository?.startsWith('beta')) throw new Error(`focus is in ${repository}`);
});

await scenario('s in the repository last opened from focuses the file below', async () => {
	await arrange({ modified: all(ALPHA) }, { modified: all(BETA) });
	await clickRow('b3.txt, Modified, beta/sub');
	await cdp.key('s');
	await expectFocus({ row: 'b1.txt, Modified, beta', tab: 'b1.txt (Working Tree)' });
});

await scenario('staging the last file of one repository focuses its lowest staged file, not a commit box', async () => {
	// The commit box command would use the repository the view last opened a row from, alpha.
	await arrange({ modified: all(ALPHA) }, { modified: ['b1.txt'], staged: ['b2.txt'] });
	await clickRow('a1.txt, Modified, alpha');
	await clickAction('b1.txt, Modified, beta', 'Stage Changes');
	await expectFocus({ row: 'b2.txt, Index Modified, beta', tab: 'b2.txt (Index)' });
});

await scenario('unstaging in one repository after opening a file in the other focuses the staged file below', async () => {
	await arrange({ modified: all(ALPHA) }, { staged: ['b1.txt', 'b2.txt'] });
	await clickRow('a1.txt, Modified, alpha');
	await clickAction('b1.txt, Index Modified, beta', 'Unstage Changes');
	await expectFocus({ row: 'b2.txt, Index Modified, beta', tab: 'b2.txt (Index)' });
});

await vs.close();
process.exit(summary() ? 0 : 1);

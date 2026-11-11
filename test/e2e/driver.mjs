// Helpers shared by the e2e runners: reading the Source Control view, clicking rows and inline
// actions, asserting focus, and running named scenarios.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatRows, rowActions, rowGeometry, SCM_STATE, sleep, waitFor } from './harness.mjs';

export function createDriver(vs) {
	const { cdp, bridge } = vs;
	const state = () => cdp.evaluate(SCM_STATE);
	const setting = (key, value) => bridge(`await vscode.workspace.getConfiguration().update(${JSON.stringify(key)}, ${JSON.stringify(value)}, vscode.ConfigurationTarget.Global); return true`);
	const command = (id, ...args) => bridge(`await vscode.commands.executeCommand(${JSON.stringify(id)}, ...${JSON.stringify(args)}); return true`);

	// The tree can still be refreshing after the last stage, which moves rows. Waits until the row
	// has been in the same place for 200ms, so a click lands on it.
	async function stableRow(label) {
		let last = null;
		return waitFor(async () => {
			const p = await cdp.evaluate(rowGeometry(label));
			const stable = p && last && p.x === last.x && p.y === last.y;
			last = p;
			if (!stable) await sleep(200);
			return stable ? p : null;
		}, { what: `row ${label}` });
	}

	async function clickRow(label) {
		const p = await stableRow(label);
		await cdp.click(p.x, p.y);
		await sleep(500);
	}

	async function clickAction(label, title) {
		const row = await stableRow(label);
		await cdp.hover(row.x, row.y);
		await sleep(200);
		const actions = await cdp.evaluate(rowActions(label));
		const action = actions.find(a => a.title === title);
		if (!action) throw new Error(`No "${title}" action on ${label}: ${actions.map(a => a.title)}`);
		await cdp.click(action.x, action.y);
	}

	/** The y position on screen of the row with this label, or null if it isn't rendered. */
	const rowTop = label => cdp.evaluate(`(() => {
		const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => r.getAttribute('aria-label') === ${JSON.stringify(label)});
		return r ? Math.round(r.getBoundingClientRect().top) : null;
	})()`);

	/** Scrolls the Source Control tree with the mouse wheel until the row is in the middle of the view. */
	async function scrollTreeTo(label) {
		const box = await cdp.evaluate(`(() => {
			const b = document.querySelector('.scm-view .monaco-list').getBoundingClientRect();
			return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, height: b.height };
		})()`);
		for (let i = 0; i < 60; i++) {
			const top = await rowTop(label);
			if (top !== null && top > box.top + box.height * 0.3 && top < box.top + box.height * 0.7) return;
			// A row that isn't rendered is further down, because scrolling starts from the top.
			const down = top === null || top > box.top + box.height / 2;
			await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: down ? 44 : -44 });
			await sleep(60);
		}
		throw new Error(`couldn't scroll to ${label}`);
	}

	/** The centre of a button in an open VS Code dialog, or null. Needs window.dialogStyle "custom". */
	const dialogButton = text => cdp.evaluate(`(() => {
		const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
		if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);

	/** Clicks a button in a VS Code dialog once it shows. */
	async function clickDialogButton(text) {
		const p = await waitFor(() => dialogButton(text), { what: `dialog button ${text}` });
		await cdp.click(p.x, p.y);
	}

	async function screenshot() {
		if (!process.env.FLN_SHOTS) return;
		const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
		const file = join(process.env.FLN_SHOTS, `fail-${Date.now()}.png`);
		writeFileSync(file, Buffer.from(shot.data, 'base64'));
		console.log(`     screenshot: ${file}`);
	}

	/**
	 * Waits until the focused row, the active tab and keyboard focus all match. `dom` is where
	 * keyboard focus should be: 'tree', 'input' (the commit message box) or 'editor'.
	 */
	async function expectFocus({ row, tab, dom = 'tree' }, timeout = 5000) {
		let last;
		let label;
		try {
			await waitFor(async () => {
				last = await state();
				// The tab label, such as "b.txt (Index)", exactly, so a plain b.txt tab doesn't match it.
				label = tab === undefined ? undefined : await bridge('return vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null');
				const domOk = dom === 'tree' ? last.domFocusInScmTree : dom === 'input' ? last.domFocusInScmInput : last.domFocusInEditor;
				return (row === undefined || last.focused === row) && (tab === undefined || label === tab) && domOk;
			}, { timeout, what: 'focus' });
		} catch {
			await screenshot();
			throw new Error(`expected row=${row} tab=${tab} dom=${dom}\n got row=${last?.focused} tab=${label ?? last?.activeTab} tree=${last?.domFocusInScmTree} input=${last?.domFocusInScmInput} editor=${last?.domFocusInEditor}\n${last ? formatRows(last) : ''}`);
		}
	}

	async function expectStable(snapshot, ms = 1500) {
		await sleep(ms);
		const s = await state();
		if (s.focused !== snapshot.focused || s.activeTab !== snapshot.activeTab) {
			throw new Error(`focus moved: ${snapshot.focused} / ${snapshot.activeTab} -> ${s.focused} / ${s.activeTab}\n${formatRows(s)}`);
		}
	}

	// A scenario fails if the extension logged a warning or an error while it ran, such as an
	// exception while moving focus, even if focus ended up in the right place.
	function extensionLog() {
		const logs = join(vs.root, 'ud', 'logs');
		const file = readdirSync(logs, { recursive: true })
			.map(String)
			.find(f => f.includes('finnbuilds.focus-next-on-stage') && f.endsWith('.log'));
		// Without the log the retry check would pass whatever happened, for example after a rename.
		if (!file) throw new Error(`No log for finnbuilds.focus-next-on-stage under ${logs}`);
		return readFileSync(join(logs, file), 'utf8');
	}

	const results = [];
	async function scenario(name, fn) {
		if (process.env.FLN_ONLY && !process.env.FLN_ONLY.split('|').some(part => name.includes(part))) return;
		const logBefore = extensionLog().length;
		try {
			await fn();
			await sleep(200);
			const problems = extensionLog().slice(logBefore).split('\n').filter(line => /\[(warning|error)\]/.test(line));
			if (problems.length) {
				throw new Error(`the extension logged:\n${problems.join('\n')}`);
			}
			results.push({ name, ok: true });
			console.log(`ok   ${name}`);
		} catch (err) {
			// A dialog left open blocks every later command, so its text says why the run stalled.
			const dialog = await cdp.evaluate(`document.querySelector('.monaco-dialog-box')?.innerText ?? null`).catch(() => null);
			const error = dialog ? `${err.message}\nan open dialog says: ${dialog.replace(/\s+/g, ' ')}` : err.message;
			results.push({ name, ok: false, error });
			console.log(`FAIL ${name}\n     ${error.replace(/\n/g, '\n     ')}`);
		}
	}

	function summary() {
		const failed = results.filter(r => !r.ok);
		console.log(`\n${results.length - failed.length}/${results.length} passed`);
		return failed.length === 0;
	}

	return { state, setting, command, clickRow, clickAction, dialogButton, clickDialogButton, expectFocus, expectStable, scenario, summary, extensionLog, rowTop, scrollTreeTo };
}

/** Shell helpers for one fixture repository. */
export function repoTools(repoDir, files) {
	const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, stdio: 'pipe' }).toString();
	const write = (file, content) => {
		mkdirSync(dirname(join(repoDir, file)), { recursive: true });
		writeFileSync(join(repoDir, file), content);
	};
	const remove = file => rmSync(join(repoDir, file));
	const initial = git('rev-parse', 'HEAD').trim();

	/** The number of SCM resources `git status` implies, counting a file in both groups twice. */
	function expectedResourceCount() {
		const conflict = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
		return git('status', '--porcelain=v1', '-uall').split('\n').filter(Boolean).reduce((count, line) => {
			const xy = line.slice(0, 2);
			if (conflict.has(xy) || xy === '??') return count + 1;
			return count + (xy[0] !== ' ' ? 1 : 0) + (xy[1] !== ' ' ? 1 : 0);
		}, 0);
	}

	/**
	 * Resets the repo, then: `modified` changed on disk, `staged` changed and staged, `partial`
	 * staged then changed again, `untracked` new files, `deleted` removed from disk, `renamed`
	 * staged renames ([from, to]), `conflicts` modified on both sides of a merge, and
	 * `deletedByThem` modified here and deleted on the merged branch.
	 */
	function reset({ modified = [], staged = [], untracked = [], partial = [], deleted = [], renamed = [], conflicts = [], deletedByThem = [] }) {
		git('reset', '-q', '--hard', initial);
		git('clean', '-qfd');
		try { git('branch', '-D', 'other'); } catch { /* no branch yet */ }
		if (conflicts.length || deletedByThem.length) {
			git('checkout', '-q', '-b', 'other');
			for (const f of conflicts) write(f, 'theirs\n');
			for (const f of deletedByThem) git('rm', '-q', '--', f);
			git('commit', '-qam', 'theirs');
			git('checkout', '-q', 'main');
			for (const f of [...conflicts, ...deletedByThem]) write(f, 'ours\n');
			git('commit', '-qam', 'ours');
			try { git('merge', '-q', 'other'); } catch { /* conflicts expected */ }
		}
		for (const f of [...modified, ...staged, ...partial]) write(f, `${files[f]}changed\n`);
		for (const f of untracked) write(f, 'new\n');
		if (staged.length || partial.length) git('add', '--', ...staged, ...partial);
		for (const [from, to] of renamed) git('mv', from, to);
		for (const f of partial) write(f, `${files[f]}changed\nagain\n`);
		for (const f of deleted) remove(f);
		return expectedResourceCount();
	}

	return { git, write, remove, reset };
}

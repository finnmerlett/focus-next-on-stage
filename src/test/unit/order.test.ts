import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayOrder, neighbour, OrderEntry } from '../../order';

const entry = (path: string, statusLabel = 'Modified'): OrderEntry & { path: string } => ({ path, segments: path.split('/'), statusLabel });
const order = (paths: string[], viewMode: 'list' | 'tree', sortKey: 'path' | 'name' | 'status' = 'path') =>
	displayOrder(paths.map(p => entry(p)), viewMode, sortKey).map(e => e.path);

test('tree view lists folders first, then files, by name at each level', () => {
	// The order the real Source Control view showed for this fixture in VS Code 1.144.
	assert.deepEqual(
		order(['a.txt', 'b.txt', 'src/c.ts', 'src/deep/d.ts', 'docs/e.md', 'src/new.ts'], 'tree'),
		['docs/e.md', 'src/deep/d.ts', 'src/c.ts', 'src/new.ts', 'a.txt', 'b.txt']);
});

test('list view by path puts files before folders at the same level', () => {
	assert.deepEqual(
		order(['src/c.ts', 'b.txt', 'a.txt', 'src/deep/d.ts', 'docs/e.md'], 'list'),
		['a.txt', 'b.txt', 'docs/e.md', 'src/c.ts', 'src/deep/d.ts']);
});

test('list view by path compares folder names by character, not by number', () => {
	// VS Code only uses the numeric file-name comparison for the last segment.
	assert.deepEqual(order(['app9/b.ts', 'core/c.ts', 'app10/a.ts'], 'list'), ['app10/a.ts', 'app9/b.ts', 'core/c.ts']);
	assert.deepEqual(order(['_posts/a.md', '.github/b.yml'], 'list'), ['.github/b.yml', '_posts/a.md']);
	assert.deepEqual(order(['f10.ts', 'f9.ts'], 'list'), ['f9.ts', 'f10.ts']);
});

test('list view by name keeps files with the same name in path order', () => {
	assert.deepEqual(order(['src/index.ts', 'src/a/index.ts', 'lib/index.ts', 'app/index.ts'], 'list', 'name'),
		['app/index.ts', 'lib/index.ts', 'src/index.ts', 'src/a/index.ts']);
});

test('list view by name sorts on the file name only', () => {
	assert.deepEqual(order(['z/a.ts', 'b.ts', 'y/c.ts'], 'list', 'name'), ['z/a.ts', 'b.ts', 'y/c.ts']);
});

test('list view by status sorts by status text, then path', () => {
	const entries = [entry('b.ts', 'Modified'), entry('a.ts', 'Untracked'), entry('c.ts', 'Deleted')];
	assert.deepEqual(displayOrder(entries, 'list', 'status').map(e => e.path), ['c.ts', 'b.ts', 'a.ts']);
});

test('tree view ignores the sort key', () => {
	assert.deepEqual(order(['z/a.ts', 'b.ts'], 'tree', 'name'), ['z/a.ts', 'b.ts']);
});

const list = ['a', 'b', 'c', 'd'];
const without = (...files: string[]) => new Set(list.filter(f => !files.includes(f)));

test('neighbour is the next remaining file below the moved one', () => {
	assert.equal(neighbour(list, without('b'), new Set(['b'])), 'c');
});

test('neighbour falls back to the file above when the moved one was last', () => {
	assert.equal(neighbour(list, without('d'), new Set(['d'])), 'c');
});

test('neighbour starts from the first of several moved files', () => {
	assert.equal(neighbour(list, without('b', 'c'), new Set(['b', 'c'])), 'd');
	assert.equal(neighbour(list, without('c', 'd'), new Set(['c', 'd'])), 'b');
});

test('neighbour passes over files it can\'t focus', () => {
	assert.equal(neighbour(list, without('a'), new Set(['a']), file => file !== 'b'), 'c');
	assert.equal(neighbour(list, without('a', 'b', 'c', 'd'), new Set(['a'])), undefined);
});

// Tree order of these paths: src/deep/d.ts, src/c.ts, z/y/x.ts, a.txt
const tree = ['src/deep/d.ts', 'src/c.ts', 'z/y/x.ts', 'a.txt'];
const folderOf = (file: string) => file.split('/').slice(0, -1);
const left = (...files: string[]) => new Set(tree.filter(f => !files.includes(f)));

test('without folders, the last file in a folder hands focus to the next folder', () => {
	assert.equal(neighbour(tree, left('src/c.ts'), new Set(['src/c.ts'])), 'z/y/x.ts');
});

test('with folders, focus stays in the folder and takes its new last file', () => {
	assert.equal(neighbour(tree, left('src/c.ts'), new Set(['src/c.ts']), undefined, folderOf), 'src/deep/d.ts');
});

test('with folders, a file below in the same folder still comes first', () => {
	assert.equal(neighbour(tree, left('src/deep/d.ts'), new Set(['src/deep/d.ts']), undefined, folderOf), 'src/c.ts');
});

test('with folders, an emptied folder falls back to the usual next file', () => {
	assert.equal(neighbour(tree, left('z/y/x.ts'), new Set(['z/y/x.ts']), undefined, folderOf), 'a.txt');
	assert.equal(neighbour(tree, left('a.txt'), new Set(['a.txt']), undefined, folderOf), 'z/y/x.ts');
});

test('with folders, an emptied subfolder climbs to its parent before leaving it', () => {
	// p/s/x.ts leaves p/s empty. p/f.ts shares p with it, so it wins over q/g.ts below.
	const order = ['p/s/x.ts', 'p/f.ts', 'q/g.ts'];
	const rest = new Set(['p/f.ts', 'q/g.ts']);
	assert.equal(neighbour(order, rest, new Set(['p/s/x.ts']), undefined, folderOf), 'p/f.ts');
	const order2 = ['p/f.ts', 'p/s/x.ts', 'q/g.ts'];
	assert.equal(neighbour(order2, rest, new Set(['p/s/x.ts']), undefined, folderOf), 'p/f.ts');
});

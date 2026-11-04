import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { sideOrderBetween, stagedBetween, takeSnapshot, unstagedBetween } from '../../changes';
import { fakeRepository } from './fakes';

const snap = (groups: Parameters<typeof fakeRepository>[0]) => takeSnapshot(fakeRepository(groups));
const names = (paths: string[]) => paths.map(p => p.replace('/repo/', '')).sort();

test('a file that moves from Changes to Staged Changes counts as staged', () => {
	const before = snap({ workingTree: ['a.txt', 'b.txt'] });
	const after = snap({ index: ['a.txt'], workingTree: ['b.txt'] });
	assert.deepEqual(names(stagedBetween(before, after)), ['a.txt']);
});

test('staging part of a file does not count, because it is still in Changes', () => {
	const before = snap({ workingTree: ['a.txt'] });
	const after = snap({ index: ['a.txt'], workingTree: ['a.txt'] });
	assert.deepEqual(stagedBetween(before, after), []);
});

test('staging the rest of a partly staged file counts', () => {
	const before = snap({ index: ['a.txt'], workingTree: ['a.txt'] });
	const after = snap({ index: ['a.txt'] });
	assert.deepEqual(names(stagedBetween(before, after)), ['a.txt']);
});

test('untracked and merge files count as unstaged', () => {
	const before = snap({ merge: ['m.txt'], untracked: ['u.txt'] });
	const after = snap({ index: ['m.txt', 'u.txt'] });
	assert.deepEqual(names(stagedBetween(before, after)), ['m.txt', 'u.txt']);
});

test('discarding a change is not a stage', () => {
	const before = snap({ workingTree: ['a.txt'] });
	const after = snap({});
	assert.deepEqual(stagedBetween(before, after), []);
});

test('a file that leaves Staged Changes counts as unstaged, even if it was also in Changes', () => {
	const before = snap({ index: ['a.txt', 'b.txt'], workingTree: ['b.txt'] });
	const after = snap({ index: ['a.txt'], workingTree: ['b.txt'] });
	assert.deepEqual(names(unstagedBetween(before, after)), ['b.txt']);
});

test('staging the deleted old path of a rename counts, although the index lists the new path', () => {
	// git mv by hand: new.txt staged as added, old.txt deleted. Staging old.txt turns them into a rename.
	const before = snap({ index: ['new.txt'], workingTree: ['old.txt'] });
	const after = snap({ index: ['new.txt<-old.txt'] });
	assert.deepEqual(names(stagedBetween(before, after)), ['old.txt']);
	assert.deepEqual(unstagedBetween(before, after), []);
});

test('the combined order puts a file that arrived on a side where the view lists it', () => {
	// Unstaging the rename new.txt <- old.txt leaves the deletion of old.txt staged.
	const before = snap({ index: ['a.txt', 'new.txt<-old.txt'] });
	const after = snap({ index: ['a.txt', 'old.txt'], untracked: ['new.txt'] });
	const order = sideOrderBetween(before, after, 'staged', 'tree', 'path').map(e => e.key.replace('/repo/', ''));
	assert.deepEqual(order, ['a.txt', 'new.txt', 'old.txt']);
});

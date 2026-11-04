import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, pickTarget, Settings, whenSideEmpty } from '../../targets';
import { fakeRepository } from './fakes';

const both = fakeRepository({ index: ['a.txt'], workingTree: ['b.txt'] });
const onlyStaged = fakeRepository({ index: ['a.txt'] });
const onlyUnstaged = fakeRepository({ workingTree: ['b.txt'] });
const with_ = (changes: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...changes });

test('after a stage, the next file while there are unstaged files left', () => {
	assert.equal(pickTarget('stage', both, DEFAULT_SETTINGS, true), 'next');
	assert.equal(pickTarget('stage', fakeRepository({ index: ['a.txt'], untracked: ['n.txt'] }), DEFAULT_SETTINGS, true), 'next');
	assert.equal(pickTarget('stage', fakeRepository({ index: ['a.txt'], merge: ['m.txt'] }), DEFAULT_SETTINGS, true), 'next');
});

test('after staging the last file, the whenAllStaged setting', () => {
	assert.equal(pickTarget('stage', onlyStaged, DEFAULT_SETTINGS, true), 'commitInput');
	assert.equal(pickTarget('stage', onlyStaged, with_({ whenAllStaged: 'lowestStaged' }), true), 'lowestStaged');
	assert.equal(pickTarget('stage', onlyStaged, with_({ whenAllStaged: 'none' }), true), undefined);
});

test('with several repositories, the commit box setting focuses the lowest staged file', () => {
	assert.equal(pickTarget('stage', onlyStaged, DEFAULT_SETTINGS, false), 'lowestStaged');
});

test('after an unstage, the next staged file while there is one', () => {
	assert.equal(pickTarget('unstage', both, DEFAULT_SETTINGS, true), 'next');
});

test('after unstaging the last staged file, the whenAllUnstaged setting', () => {
	assert.equal(pickTarget('unstage', onlyUnstaged, DEFAULT_SETTINGS, true), 'topUnstaged');
	assert.equal(pickTarget('unstage', onlyUnstaged, with_({ whenAllUnstaged: 'none' }), true), undefined);
	assert.equal(pickTarget('unstage', fakeRepository({}), DEFAULT_SETTINGS, true), undefined);
});

test('when the files left on a side can\'t be focused, the side counts as empty', () => {
	assert.equal(whenSideEmpty('unstage', both, DEFAULT_SETTINGS, true), 'topUnstaged');
	assert.equal(whenSideEmpty('unstage', both, with_({ whenAllUnstaged: 'none' }), true), undefined);
	assert.equal(whenSideEmpty('stage', both, DEFAULT_SETTINGS, true), 'commitInput');
});

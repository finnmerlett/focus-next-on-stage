import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInside, pathKey } from '../../paths';

test('isInside accepts files and folders whose names start with two dots', () => {
	assert.equal(isInside('/r/..env', '/r'), true);
	assert.equal(isInside('/r/..cache/x', '/r'), true);
	assert.equal(isInside('/r/a/b.ts', '/r'), true);
});

test('isInside rejects the root itself, parents and siblings', () => {
	assert.equal(isInside('/r', '/r'), false);
	assert.equal(isInside('/other/a.ts', '/r'), false);
	assert.equal(isInside('/r2/a.ts', '/r'), false);
});

test('pathKey ignores case on macOS and Windows only', () => {
	assert.equal(pathKey('/Users/X/Repos/A.ts', 'darwin'), '/users/x/repos/a.ts');
	assert.equal(pathKey('C:\\Repos\\A.ts', 'win32'), 'c:\\repos\\a.ts');
	assert.equal(pathKey('/home/x/A.ts', 'linux'), '/home/x/A.ts');
});

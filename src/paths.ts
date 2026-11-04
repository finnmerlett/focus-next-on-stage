// Kept free of runtime vscode imports so the unit tests can load it under plain Node.
import * as path from 'node:path';

/**
 * A path key that compares the way git does on this platform. macOS and Windows file systems
 * ignore case, so a workspace opened as ~/repos/app still matches git's ~/Repos/app.
 */
export function pathKey(fsPath: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'darwin' || platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** True when `file` is inside the folder `root`. */
export function isInside(file: string, root: string): boolean {
	const relative = path.relative(pathKey(root), pathKey(file));
	return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

/** The path segments of `file` below `root`. */
export function segmentsBelow(root: string, file: string): string[] {
	return path.relative(root, file).split(path.sep);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The same comparison VS Code uses for file names in trees (compareFileNames in comparers.ts). */
export function compareFileNames(one: string, other: string): number {
	const result = collator.compare(one, other);
	// The numeric option makes "foo1" and "foo01" equal, so the shorter name goes first.
	return result === 0 && one !== other ? (one < other ? -1 : 1) : result;
}

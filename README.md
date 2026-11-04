# Focus Next on Stage

Since VS Code 1.86, staging or unstaging the focused file in the Source Control view leaves nothing focused, so the next key press does nothing useful ([microsoft/vscode#207066](https://github.com/microsoft/vscode/issues/207066)). This extension focuses the next file in the list instead, and opens it the way a single click would: in a preview editor, with keyboard focus left in Source Control.

- After a file is staged, it focuses the unstaged file listed below it, or the one above it if the staged file was last.
- After a file is unstaged, it does the same in Staged Changes.
- The list only scrolls when the next file is out of sight, and folders are never collapsed.

It follows the inline `+` and `−` buttons, the context menu, `Stage All Changes`, `Git: Stage Changes` and the extension's own keyboard commands. Staging from a terminal (`git add`) doesn't move focus.

## Keyboard staging

Bind keys to the extension's commands in place of `git.stage` and `git.unstage` in `keybindings.json`. The `args` tell the extension how the view is laid out, which it can't find out otherwise (see "How it works"):

```jsonc
{ "key": "s", "command": "focusNextOnStage.stage", "args": { "viewMode": "tree" },
  "when": "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild && scmViewMode == 'tree'" },
{ "key": "s", "command": "focusNextOnStage.stage", "args": { "viewMode": "list" },
  "when": "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild && scmViewMode == 'list'" },
{ "key": "shift+s", "command": "focusNextOnStage.unstage", "args": { "viewMode": "tree" },
  "when": "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild && scmViewMode == 'tree'" },
{ "key": "shift+s", "command": "focusNextOnStage.unstage", "args": { "viewMode": "list" },
  "when": "focusedView == 'workbench.scm' && listFocus && !inputFocus && treeElementHasParent && !treeElementHasChild && scmViewMode == 'list'" }
```

If you use list view sorted by name or status, add entries for each sort order you use after the ones above, with `"args": { "viewMode": "list", "viewSortKey": "name" }` (or `"status"`, or `"path"`) and `&& scmViewSortKey == 'name'` in `when`. Add the `path` entry too if you switch between sort orders and `scm.defaultViewSortKey` isn't `path`, because the plain list entries fall back to that setting.

The keys stage or unstage the highlighted row, also after you've moved the highlight with the arrow keys. `git.stage` and `git.unstage` act on the file in the active editor, so the extension first opens the highlighted row, as Space does. For most rows the editor opens straight away, and the key press takes no longer. With `git.openDiffOnClick` off, or with merge conflicts open in the merge editor, the extension can't tell whether the row's file was already open, so a key press can wait up to 250 ms for an editor to open. `treeElementHasParent && !treeElementHasChild` keeps the keys off folder rows, because opening a folder row collapses it.

`Unstage and Focus Next` also unstages a file that has both staged and unstaged changes, and `Stage and Focus Next` stages an untracked file when `git.untrackedChanges` is `separate`. Plain `git.unstage` and `git.stage` key bindings skip both.

## Settings

The first two settings decide where focus goes when the side of the view you moved a file from is empty. The third changes which file counts as next in tree view.

| Setting | Default | What it does |
|---|---|---|
| `focusNextOnStage.whenAllStaged` | `commitInput` | After staging the last unstaged file: `commitInput` (the commit message box), `lowestStaged` (the last staged file) or `none`. With several repositories open, `commitInput` focuses the last staged file instead, because VS Code's commit box command may pick another repository. |
| `focusNextOnStage.whenAllUnstaged` | `topUnstaged` | After unstaging the last staged file: `topUnstaged` (the first unstaged file) or `none`. |
| `focusNextOnStage.stayInFolder` | `false` | In tree view, keep focus inside the moved file's folder while it has files left. Staging the last file in a folder then focuses the folder's new last file, not the first file of the next folder. When the folder is empty, focus moves to the closest enclosing folder with files left. |

## Commands

| Command | Title |
|---|---|
| `focusNextOnStage.stage` | Stage and Focus Next |
| `focusNextOnStage.unstage` | Unstage and Focus Next |

## How it works

VS Code has no API for focusing a row in the Source Control view, so the extension gets the view to do it. It works out which file is listed after the one that moved, from git's state and the view's sort rules. It then runs the same command a click on that row runs, and VS Code's `scm.autoReveal` (on by default) focuses and selects the row. autoReveal only scrolls when the row is out of sight, and it doesn't move keyboard focus. A staged diff or a deleted file opens through a `git:` URI, which autoReveal doesn't match, so for those the extension also opens the file itself for a moment, then shows the diff again, and closes the file's tab if that added one. If you start typing or clicking in an editor, or switch to another window, before it has opened anything, it stops.

The order depends on whether the view is a tree or a list, and on the sort order in list view. The toolbar toggles keep those in workspace storage, which extensions can't read. The keybindings above pass them in their `args`, and the extension remembers the last values for the inline buttons. Before the first key press in a workspace it uses the `scm.defaultViewMode` and `scm.defaultViewSortKey` settings, so set `scm.defaultViewMode` to match if you use tree view.

To follow the inline buttons, the extension listens for the git extension's `Add`, `Remove` and `RevertFiles` operations. Those events, and the rows' click commands, come from the git extension's internal `model` export, which isn't public API. If a VS Code update removes or changes it, the extension logs a warning to the "Focus Next on Stage" output channel, and focus no longer moves after staging. The two commands still stage and unstage.

Known limits:

- It needs `scm.autoReveal`, which is on by default.
- autoReveal can only select the unstaged row of a file that has both staged and unstaged changes. After an unstage, the extension passes over such a file and focuses the one after it. If only such files are left in Staged Changes, `whenAllUnstaged` applies.
- autoReveal only reacts when the active editor changes. If the file to focus is already open as the active editor and its row opens the file itself (an untracked file, or any file with `git.openDiffOnClick` off), its row can't be focused.
- It can't tell a stage from the Source Control view apart from `Git: Stage Changes` in the Command Palette, the `Stage Changes` button in an editor's title bar or a stage made by another extension, so they all move focus. While the multi-file diff editor (`View Changes`) is the active editor, stages and unstages don't move focus, because opening the next file would replace that editor. The keys bound to the extension's commands still move it.
- Staging selected lines or a single change (`git.stageSelectedRanges`, `git.stageChange`) isn't followed, even when it stages a whole file, because git runs those as a different operation.
- If the next file is already showing in another editor group, it opens a second copy in the active group, where a click on its row would switch to the other group.
- If the next file has unsaved changes, focusing its row can leave an extra tab for the file open, because closing that tab would ask whether to save the changes.
- With `workbench.editor.limit.enabled` on and the limit reached, focusing a staged diff or a deleted file can close your least recently used editor, because the file the extension opens for a moment counts as one more. This happens with previews off, or when the diff is already open in a pinned tab.
- In list view sorted by status, the view sorts by the status text in your display language, and the extension by the English text, so with another language the next file can be the wrong one.
- When the highlighted row doesn't open an editor, the keys stage or unstage the file in the active editor instead. That happens on a conflict that is Added By Us, Added By Them or Both Deleted. It also happens on the commit message box row and the `Commit` button row when repository rows are shown, and the key then moves keyboard focus into the box or onto the button.
- Rows that open in an image editor or a custom editor can't be staged with the keys, and the first such row in a session can make `s` stage the file that was open before.
- With `git.mergeEditor` on, a merge conflict row that takes longer than 250 ms to open can make `s` stage the file that was open before. git runs two `git diff` commands before it opens the merge editor, which can take that long in a large repository.

## Install

```bash
npm install
npm run package
code --install-extension focus-next-on-stage-0.4.0.vsix
```

When updating an installed version, run **Developer: Reload Window** afterwards. **Developer: Restart Extension Host** keeps running the version it loaded before.

## Development

`npm run compile` builds to `out/`. `npm run test:unit` runs the unit tests.

`npm run test:e2e` opens a separate VS Code window with a throwaway profile on a fixture repository, then stages and unstages through real key presses and button clicks over the Chrome DevTools Protocol. `npm run test:e2e:multi` does the same with two repositories. A scenario fails if the extension logged a warning or an error. The window is hidden as soon as VS Code creates it, so it doesn't take focus from the app you're using: the harness starts the VS Code main process paused and patches Electron's window calls before VS Code runs. The runs need VS Code at `/Applications/Visual Studio Code.app` (or set `FLN_CODE_BIN` and `FLN_CODE_CLI`) and take a few minutes. Useful variables:

- `FLN_ONLY`: run only the scenarios whose name contains this text. Separate alternatives with `|`.
- `FLN_VSIX`: install this packaged `.vsix` instead of loading the source folder.
- `FLN_EXTRA_EXTENSIONS`: also load these extension folders, separated by `:`, for example an installed VSCodeVim.
- `FLN_SHOW`: show the test window instead of hiding it, for watching or debugging a run.
- `FLN_SHOTS`: save a screenshot to this folder when a scenario fails. Use it with `FLN_SHOW`.
- `FLN_KEEP`: keep the throwaway profile, including the extension's debug log under `ud/logs`.

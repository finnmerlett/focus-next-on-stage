# Focus Next on Stage

Since VS Code 1.86, staging or unstaging a file in the Source Control view leaves nothing focused ([microsoft/vscode#207066](https://github.com/microsoft/vscode/issues/207066)). This extension focuses the next file in the list instead, and opens it the way a single click would, so you can work down the list without reaching for the mouse.

- After you stage a file, the next unstaged file is focused (or the one above, if it was the last).
- After you unstage a file, the same happens in Staged Changes.

## Quick start

Install [Focus Next on Stage](https://marketplace.visualstudio.com/items?itemName=finnbuilds.focus-next-on-stage) from the Extensions view, or run:

```bash
code --install-extension finnbuilds.focus-next-on-stage
```

Then stage or unstage a file with the `+` and `−` buttons, the context menu or `Git: Stage Changes`, and focus moves to the next file.

## Advanced use

### Keyboard staging

To stage and unstage the highlighted row from the keyboard, add these to `keybindings.json`. The example uses `s` and `shift+s`, but any keys work:

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

The `args` tell the extension whether the view is a tree or a list, which extensions can't read. If you use list view sorted by name or status, see [Sort orders](#sort-orders).

### Settings

| Setting | Default | What it does |
|---|---|---|
| `focusNextOnStage.whenAllStaged` | `commitInput` | Where focus goes after staging the last unstaged file: `commitInput` (the commit message box), `lowestStaged` (the last staged file) or `none`. |
| `focusNextOnStage.whenAllUnstaged` | `topUnstaged` | Where focus goes after unstaging the last staged file: `topUnstaged` (the first unstaged file) or `none`. |
| `focusNextOnStage.stayInFolder` | `false` | In tree view, keep focus inside the folder of the moved file while it still has files. |

## How it works

VS Code has no API for focusing a row in the Source Control view. The extension works out which file comes next from git's state and the view's sort order, then opens that file the way a click on its row would. VS Code's `scm.autoReveal` setting (on by default) then focuses and selects the row. Staged diffs and deleted files open through `git:` URIs, which autoReveal doesn't match, so for those the extension briefly opens the file itself and then the diff again.

To notice stages and unstages from the buttons, the extension listens to the git extension's internal API. If a VS Code update changes that API, the extension logs a warning to the "Focus Next on Stage" output channel and focus stops moving, but the two commands still stage and unstage.

The keyboard commands act on the highlighted row. `git.stage` and `git.unstage` only act on the active editor, so the extension opens the highlighted row first, as Space does. The `when` clauses keep the keys off folder rows, because opening a folder row collapses it.

### Sort orders

The order of the list depends on tree or list view and, in list view, on the sort order. VS Code keeps those in workspace storage, so the extension takes them from the keybinding `args` and remembers the last values for the buttons. Before the first key press in a workspace, it falls back to the `scm.defaultViewMode` and `scm.defaultViewSortKey` settings.

For list view sorted by name or status, add entries after the ones above with `"args": { "viewMode": "list", "viewSortKey": "name" }` (or `"status"`) and `&& scmViewSortKey == 'name'` in `when`. If you switch between sort orders, add a `"path"` entry too.

<details>
<summary>Known limits</summary>

- `scm.autoReveal` must be on.
- Staging from a terminal (`git add`), and staging selected lines or a single change, doesn't move focus.
- The extension can't tell a stage in the Source Control view from one made by `Git: Stage Changes`, the editor title bar button or another extension, so all of them move focus. Stages made while the multi-file diff editor is active don't move focus.
- A file with both staged and unstaged changes can only be focused on the unstaged side, so after an unstage it's skipped.
- If the next file is already the active editor and its row opens the file itself (an untracked file, or any file with `git.openDiffOnClick` off), its row can't be focused.
- If the next file is open in another editor group, a second copy opens in the active group.
- If the next file has unsaved changes, an extra tab for it can be left open.
- With `workbench.editor.limit.enabled` on and the limit reached, focusing a staged diff or deleted file can close the least recently used editor.
- In list view sorted by status with a display language other than English, the next file can be the wrong one.
- The keys can't stage rows that open in an image or custom editor, or conflicts that don't open an editor (Added By Us, Added By Them, Both Deleted). On those rows, and on slow merge conflict rows with `git.mergeEditor` on, a key press can stage the file in the active editor instead.

</details>

## Development

```bash
npm install
npm run compile     # build to out/
npm run test:unit   # unit tests
npm run test:e2e    # end-to-end tests in a hidden VS Code window
npm run package     # build a .vsix
```

The end-to-end tests drive a real VS Code with a throwaway profile over the Chrome DevTools Protocol. They expect VS Code at `/Applications/Visual Studio Code.app`; set `FLN_CODE_BIN` and `FLN_CODE_CLI` to use another path. Set `FLN_ONLY=<text>` to run only matching scenarios, and `FLN_SHOW=1` to watch the window.

## License

[MIT](LICENSE)

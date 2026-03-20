---
name: use-git-rm-for-tracked-files
enabled: true
event: bash
action: block
pattern: ^rm\s+(?!-rf\s+(node_modules|\.next|dist|build)\b)
---

**Use `git rm` instead of `rm` for tracked files.**

BLOCKED. You used `rm` to delete what appears to be a source file. If this file is tracked by git, use `git rm` instead:

```bash
git rm path/to/file        # delete + stage in one step
git rm --cached path/to/file  # untrack without deleting from disk
```

**Why:** `rm` removes from disk but leaves git tracking dirty — you then need a separate `git add` to stage the deletion. `git rm` does both atomically. Using plain `rm` on tracked files leads to inconsistent staging and easy mistakes.

**Exception:** If the file is genuinely untracked (not in git), plain `rm` is fine. Check with `git ls-files <path>` if unsure.

# AI Code Review Evidence

Local-first recording and review of AI agent judgments bound to files, line ranges, and git revisions.

## Terms

**Review view**:
The read-only source the Review UI is currently showing for a registered repository. It is either the working tree or a local branch tip. The working tree is the default. Choosing a local branch does not check that branch out.

_Avoid_: checkout, current branch, HEAD

**Working tree**:
The registered repository root's current files, including uncommitted changes. It is the default review view.

_Avoid_: HEAD, current branch, checkout

**Local branch**:
A named branch under `refs/heads` in the registered repository. When it is the review view, the Review UI shows that branch's tip tree.

_Avoid_: remote-tracking branch, tag

**Diff base**:
The old side of a file comparison. It is the newest commit-revision judgment for that file, or the tip commit of the review view when no such judgment exists.

_Avoid_: HEAD

**Diff current**:
The new side of a file comparison. It is the review view's current content for that path: the working-tree file, or the blob at the selected local branch tip.

_Avoid_: HEAD, working tree

# The caught wrong-fix (the founding scar, replayed)

The report: **"the modal is cut off"** (issue #7). The agent reads it as a *height*
problem. The real bug: the modal is too **narrow**.

Run it (from the repo root, zero dependencies):

```bash
node examples/caught-wrong-fix/run-demo.js
```

Two PRs go through the real enforcer:

| PR | The fix | The carried test | Verdict |
|---|---|---|---|
| 1 | caps the height (wrong axis) | asserts the height cap | **BLOCK** - `weak receipt: the test PASSES on the base commit` |
| 2 | widens the modal | pins the EXACT width (G14-proof: not "wider than before") | **PASS** - `red on base, green on fix` |

The point: PR 1 is green everywhere - the code "works", its test passes, CI would be
happy. The enforcer rejects it anyway, because the carried test **passes on the buggy
base**: it never reproduced the reported symptom, so it proves nothing about it. The
wrong-axis fix shipped once in production with every check green; only the reporter
caught it. Now the PR gate does - that catch is the product.

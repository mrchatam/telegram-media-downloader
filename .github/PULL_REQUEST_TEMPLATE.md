## What changed

<!-- One or two sentences. Link the issue this closes, e.g. "Closes #12". -->

## How to test

<!-- Steps a reviewer can follow after loading dist/ in chrome://extensions. -->

- [ ] `npm run verify` passes
- [ ] Tested manually on Web K (`/k`)
- [ ] Tested manually on Web A (`/a`)
- [ ] `CHANGELOG.md` updated under **Unreleased** (for user-visible changes)
- [ ] Version bumped for a release (`npm version <level> --no-git-tag-version` + `npm run version:sync`)

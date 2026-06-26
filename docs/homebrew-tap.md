# Homebrew distribution

## Quick install (no tap)

After pushing to GitHub, colleagues can install directly:

```bash
brew install https://raw.githubusercontent.com/you/gitlab-release-train/main/Formula/gitlab-mr-train.rb
```

Replace `you/gitlab-release-train` with your GitHub org/user and repo name.

## Tap install (recommended for teams)

1. Create a public GitHub repo named `homebrew-gitlab-mr-train` (must start with `homebrew-`).

2. Copy `Formula/gitlab-mr-train.rb` into that repo under `Formula/`.

3. Colleagues run:

```bash
brew tap you/gitlab-mr-train
brew install gitlab-mr-train
brew upgrade gitlab-mr-train   # later updates
```

Homebrew strips the `homebrew-` prefix from the tap name.

## Cutting a release

1. Update `url` and `sha256` in the formula:

```bash
curl -L https://github.com/you/gitlab-release-train/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256
```

2. Tag and push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

3. Commit the updated formula SHA256 to main (and your tap repo if separate).

## Cost

Public GitHub tap + releases are free. No npm org or paid registry required.

## Prerequisites for users

- Node.js 20+ (installed by formula via `node@20`)
- git
- [glab](https://gitlab.com/gitlab-org/cli) authenticated against their GitLab instance

```bash
brew install glab
glab auth login
gitlab-mr-train init
gitlab-mr-train
```

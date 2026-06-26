# gitlab-mr-train

Interactive CLI for running dependent GitLab merge requests in order.

Typical flow:

```text
libA -> libB -> appA
```

Waits for each MR/pipeline, merges when ready, triggers pack jobs, updates downstream package versions, runs `npm install`, commits, pushes, then continues.

## Requirements

- Node.js 20+
- npm
- git
- [glab](https://gitlab.com/gitlab-org/cli) authenticated against GitLab

```bash
glab --version
glab auth status
```

## Install

### Homebrew (recommended)

```bash
brew install https://raw.githubusercontent.com/you/gitlab-release-train/main/Formula/gitlab-mr-train.rb
```

See [docs/homebrew-tap.md](docs/homebrew-tap.md) for tap setup and release workflow.

### From source

```bash
git clone https://github.com/you/gitlab-release-train.git
cd gitlab-release-train
npm install
npm run build
npm link
```

## First run

```bash
gitlab-mr-train init    # interactive repos.yaml in ~/.config/gitlab-mr-train/
gitlab-mr-train         # pick active train, start new, or resume
```

Config lives in `~/.config/gitlab-mr-train/`:

| Path | Purpose |
|------|---------|
| `repos.yaml` | Repo registry (GitLab URLs, package names; `path` used only by `init`) |
| `trains/<slug>/train.yaml` | Per-train definition |
| `trains/<slug>/state.json` | Per-train resume state |
| `workspaces/<slug>/` | Isolated git clones during execute (removed on success) |

## Concurrent trains

Each train has its own state and workspace. While train A waits on a pipeline in terminal 1, open terminal 2 and run `gitlab-mr-train` → **Start new train**.

## Isolated workspaces

In **execute mode**, git/npm operations never touch the `path` in `repos.yaml`. Each train clones repos into `workspaces/<slug>/`, works there, pushes to GitLab, and deletes the workspace when the train completes.

Dependency updates commit to the **MR source branch** (not main) when the downstream step has an `mr` configured.

## Commands

| Command | Description |
|---------|-------------|
| `gitlab-mr-train` | Pick active train, resume, or start new |
| `gitlab-mr-train init` | Set up repo registry |
| `gitlab-mr-train init --add` | Add repos to existing config |
| `gitlab-mr-train init --edit <id>` | Update one repo |
| `gitlab-mr-train abort [--train <slug>]` | Clear train state + workspace |
| `gitlab-mr-train run <file.yaml> [--train <slug>] [--execute]` | Run a train file directly |
| `gitlab-mr-train resume [--train <slug>] [--execute]` | Resume a train |
| `gitlab-mr-train reset <step-id> [--train <slug>]` | Reset a step for re-run |

Default mode is **dry-run**. Confirm execution in the wizard, or pass `--execute`.

## Repo registry example

See [config/repos.example.yaml](config/repos.example.yaml). The `path` field is for `init` git auto-detect only; execute mode clones from `gitlab` URL.

```yaml
repos:
  libA:
    name: LibraryA
    path: ~/projects/lib-a
    gitlab: https://gitlab.com/acme/lib-a
    mainBranch: main
    packageName: "@acme/lib-a"
    versionPackageJson: lib/package.json
    dependencyPackageJsons: [package.json, lib/package.json]
```

## Train example

See [examples/libA-libB-appA.yaml](examples/libA-libB-appA.yaml). Wizard-created trains use `reposFile: ../../repos.yaml` relative to `trains/<slug>/train.yaml`.

Pack jobs are fetched live from GitLab during the wizard (manual CI jobs on main branch).

## Workflow per step

1. Poll MR until ready (open, pipeline success, mergeable)
2. Merge via `glab mr merge`
3. Wait for main branch pipeline
4. Trigger pack job if configured
5. Clone/pull main in workspace; read library version
6. Clone/checkout MR branch in workspace; update deps, `npm install`, commit, push
7. Continue to next step

## Resume after failure

```bash
gitlab-mr-train                              # pick the failed train
gitlab-mr-train resume --train my-slug --execute
gitlab-mr-train reset libB --train my-slug
```

Workspace is kept on failure for resume; removed on success or abort.

## Development

```bash
npm run dev -- help
npm run dev -- run examples/libA-libB-appA.yaml --train dev-test
npm run check
```

## Limitations

- Dry-run does not call GitLab or clone repos
- `localCommand` pack type is schema-only, not implemented
- Approval/unresolved-discussion checks not implemented
- HTTPS clone URLs only (from `gitlab` field); git credentials must allow push

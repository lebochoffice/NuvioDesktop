#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_REPOSITORY:-}" != 'lebochoffice/NuvioDesktop' || "${GITHUB_REF:-}" != 'refs/heads/Dev' ]]; then
  echo 'This workflow only operates in the personal fork on Dev.' >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" ]]; then echo 'A repository-scoped Actions token is required.' >&2; exit 1; fi

upstream='https://github.com/NuvioMedia/NuvioDesktop.git'
branch='updates/nuvio-dev'
git fetch --no-tags origin 'refs/heads/Dev:refs/remotes/origin/Dev'
git fetch --no-tags "$upstream" 'refs/heads/Dev:refs/remotes/nuvio-upstream/Dev'
tip="$(git rev-parse refs/remotes/nuvio-upstream/Dev)"
base="$(git rev-parse refs/remotes/origin/Dev)"
[[ "$tip" =~ ^[0-9a-f]{40}$ && "$base" =~ ^[0-9a-f]{40}$ ]] || exit 1
git merge-base "$base" "$tip" >/dev/null || { echo 'Histories have no common ancestor; manual review required.' >&2; exit 1; }
if git merge-base --is-ancestor "$tip" "$base"; then
  echo 'Dev already contains the upstream tip. Nothing to propose.'
  exit 0
fi

# Push only an upstream-tip branch inside the fork. Never touch Dev, merge,
# force-push, execute fetched code, approve PRs, or create tags/releases.
git push origin "$tip:refs/heads/$branch"
existing="$(gh pr list --repo "$GITHUB_REPOSITORY" --base Dev --head "$branch" --state open --json url --jq '.[0].url // empty')"
if [[ -n "$existing" ]]; then
  echo "Review PR updated by fast-forward only: $existing"
  exit 0
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
cat > "$body" <<EOF
## Summary

Propose the official NuvioDesktop Dev tip for this personal fork. Implementation changes are unapproved until reviewed.

## PR type

- [x] Proposed upstream update for human review

## Why

Keep the personal fork current while preserving its own Watch in Browser integration.

## Desktop scope

Desktop upstream commits; inspect the complete diff for platform/shared-code effects.

## Issue or approval

The owner requested update proposals, not automatic approval of their contents. No approval or merge is implied.

## UI / behavior impact

- [x] Impact remains subject to human review of the upstream diff

## Policy check

- [x] This automation only proposes changes inside the personal fork.
- [x] No merge, approval, deployment, tag or release was performed.

## Scope boundaries

Upstream: https://github.com/NuvioMedia/NuvioDesktop/commit/$tip
Fork base when proposed: $base

Review the diff, resolve any conflicts, and retain Watch in Browser, browser-site,
fork-maintenance, and the fork-only workflows. This PR remains for a human.

## Testing

No application test is claimed by the update proposal. Review the separate Fork - Windows MSI PR checks.

After your review and manual merge into Dev, run **Fork - Windows MSI** manually
on Dev to build a downloadable artifact. This draft does not authorize a release.

## Screenshots / Video

No upstream UI verification is claimed. Inspect UI-affecting changes before accepting this proposal.

## Breaking changes

Unknown until reviewed; inspect upstream migrations, build settings and protocol changes.

## Linked issues

No issue is created automatically. Consult the linked upstream commit and its referenced PRs.
EOF
gh pr create --repo "$GITHUB_REPOSITORY" --base Dev --head "$branch" --draft \
  --title 'Review Nuvio Desktop Dev updates' --body-file "$body"

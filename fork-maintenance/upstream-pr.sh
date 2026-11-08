#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_REPOSITORY:-}" != 'lebochoffice/NuvioDesktop' || "${GITHUB_REF:-}" != 'refs/heads/Dev' ]]; then
  echo 'This workflow only operates in the personal fork on Dev.' >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" ]]; then echo 'A repository-scoped Actions token is required.' >&2; exit 1; fi

upstream='https://github.com/NuvioMedia/NuvioDesktop.git'
branch='updates/nuvio-dev'               # official tip, for reference/conflict review
integration='updates/nuvio-integration'  # fork Dev + official tip, checked
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

# Never touch Dev, force-push Dev, execute fetched code, approve PRs, or
# create tags/releases. The invariant checker is taken from the fork's Dev
# (not from the merged tree) and only greps files.
checker="$(mktemp)"; body="$(mktemp)"
trap 'rm -f "$checker" "$body"' EXIT
git show "$base:fork-maintenance/check-fork-invariants.sh" > "$checker" 2>/dev/null \
  || { echo "fork-maintenance/check-fork-invariants.sh is not on Dev yet; merge the fork automation first." >&2; exit 1; }

git push origin "$tip:refs/heads/$branch"
git config user.name 'nuvio-fork-sync'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git checkout -q -B "$integration" "$base"
status='clean'
if git merge --no-ff --no-edit -m "Merge official NuvioDesktop Dev ${tip:0:12} into fork" "$tip"; then
  bash "$checker" || status='invariants'
else
  git merge --abort || true
  status='conflict'
fi

write_body() {
  local kind="$1" detail="$2"
  cat > "$body" <<EOF
## Summary

$kind official NuvioDesktop Dev update for this personal fork ($detail).

## PR type

- [x] Proposed upstream update for human review

## Why

Keep the personal fork current while preserving its own features: browser watch party (browser-site), TorBox HLS, Cloudflare invitation link, intro-skip configuration guard, browser sync, fork updater and the original desktop player.

## Desktop scope

Desktop upstream commits; inspect the complete diff for platform/shared-code effects.

## Issue or approval

Automated proposal. No approval or merge is implied unless the owner enabled auto-merge for clean, fully checked integrations.

## UI / behavior impact

- [x] Impact remains subject to human review of the upstream diff

## Policy check

- [x] This automation only proposes changes inside the personal fork.
- [x] No force-push to Dev, approval, deployment, tag or release was performed.

## Scope boundaries

Upstream: https://github.com/NuvioMedia/NuvioDesktop/commit/$tip
Fork base: $base
Integration status: $status

## Testing

The Fork - Windows MSI workflow runs browser tests, fork invariants and desktop tests on this PR. Failing checks block the merge. Releases are only created by the separate, manually approved Fork - Release workflow.

## Screenshots / Video

No upstream UI verification is claimed.

## Breaking changes

Unknown until reviewed; inspect upstream migrations, build settings and protocol changes.

## Linked issues

No issue is created automatically. Consult the linked upstream commit.
EOF
}

if [[ "$status" == 'clean' ]]; then
  # The integration branch is fork-owned scratch space; it is rebuilt from Dev
  # each run, so --force-with-lease applies to it only, never to Dev.
  git push --force-with-lease origin "HEAD:refs/heads/$integration"
  write_body 'Integrate the' 'merged without conflicts; fork invariants intact'
  pr="$(gh pr list --repo "$GITHUB_REPOSITORY" --base Dev --head "$integration" --state open --json url --jq '.[0].url // empty')"
  if [[ -z "$pr" ]]; then
    pr="$(gh pr create --repo "$GITHUB_REPOSITORY" --base Dev --head "$integration" --draft \
      --title 'Integrate Nuvio Desktop Dev updates (checked)' --body-file "$body")"
  else
    gh pr edit "$pr" --body-file "$body"
  fi
  echo "Integration PR: $pr"
  # Optional, off by default: merge automatically only after all required
  # checks pass (needs branch protection with required checks on Dev).
  if [[ "${FORK_AUTO_MERGE:-false}" == 'true' ]]; then
    gh pr ready "$pr" || true
    gh pr merge "$pr" --auto --merge
  fi
  exit 0
fi

detail="$([[ "$status" == 'conflict' ]] && echo 'merge conflicts; manual resolution required' || echo 'merged, but a fork feature was removed or reverted; see the Fork invariants log')"
write_body 'Review the' "$detail"
existing="$(gh pr list --repo "$GITHUB_REPOSITORY" --base Dev --head "$branch" --state open --json url --jq '.[0].url // empty')"
if [[ -n "$existing" ]]; then
  gh pr edit "$existing" --body-file "$body"
  echo "Review PR updated ($status): $existing"
else
  gh pr create --repo "$GITHUB_REPOSITORY" --base Dev --head "$branch" --draft \
    --title "Review Nuvio Desktop Dev updates ($status)" --body-file "$body"
fi
# A blocked update is a failed run, so it is visible in the Actions tab.
exit 1

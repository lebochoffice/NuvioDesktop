#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_REPOSITORY:-}" != 'lebochoffice/NuvioDesktop' || "${GITHUB_REF:-}" != 'refs/heads/Dev' ]]; then
  echo 'This workflow only operates in the personal fork on Dev.' >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" ]]; then echo 'A repository-scoped Actions token is required.' >&2; exit 1; fi

upstream_repo='NuvioMedia/NuvioDesktop'
tag_pattern='^v?[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta)([.-][0-9]+)?)?$'
retry_pr="${NUVIO_RETRY_PR:-}"
requested_tag=''
if [[ -n "$retry_pr" ]]; then
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "$retry_pr" =~ ^[1-9][0-9]*$ ]]
  prior="$(gh pr view "$retry_pr" --repo "$GITHUB_REPOSITORY" --json state,baseRefName,headRefName,isCrossRepository,body)"
  jq -e '.state == "CLOSED" and .baseRefName == "Dev" and .isCrossRepository == false' <<< "$prior" >/dev/null
  prior_marker="$(jq -r '.body' <<< "$prior" |
    sed -nE 's/^<!-- nuvio-upstream-release: ([^ ]+) ([0-9]+) ([0-9a-f]{40}) -->$/\1 \2 \3/p')"
  read -r requested_tag prior_id prior_sha <<< "$prior_marker"
  [[ "$requested_tag" =~ $tag_pattern && "$prior_marker" == "$requested_tag $prior_id $prior_sha" &&
     "$prior_id" =~ ^[0-9]+$ && "$prior_sha" =~ ^[0-9a-f]{40}$ ]]
  prior_head="$(jq -r '.headRefName' <<< "$prior")"
  prior_version="${requested_tag#v}"
  case "$prior_head" in
    "updates/nuvio-integration-$prior_version"|"updates/nuvio-review-$prior_version"|\
    "updates/nuvio-integration-$prior_version-retry-"[0-9]*|"updates/nuvio-review-$prior_version-retry-"[0-9]*) ;;
    *) echo 'Retry requires a closed upstream integration or review PR.' >&2; exit 1 ;;
  esac
fi
candidate="$(gh api --paginate --slurp "repos/$upstream_repo/releases?per_page=100" |
  jq -r --arg pattern "$tag_pattern" --arg tag "$requested_tag" '[.[][] | select(.draft == false and (.published_at != null))
    | select(.tag_name | test($pattern)) | select($tag == "" or .tag_name == $tag)]
    | max_by([.published_at, .id]) // empty | [.tag_name, .id] | @tsv')"
if [[ -z "$candidate" ]]; then
  echo 'No published upstream version matched the supported release tags.'
  [[ -z "$retry_pr" ]] || exit 1
  exit 0
fi
IFS=$'\t' read -r tag release_id <<< "$candidate"
[[ "$tag" =~ $tag_pattern && "$release_id" =~ ^[0-9]+$ ]]
version="${tag#v}"
review="updates/nuvio-review-$version"
integration="updates/nuvio-integration-$version"

git fetch --no-tags origin 'refs/heads/Dev:refs/remotes/origin/Dev'
git fetch --no-tags "https://github.com/$upstream_repo.git" "refs/tags/$tag:refs/nuvio-upstream/releases/$tag"
tip="$(git rev-parse --verify "refs/nuvio-upstream/releases/$tag^{commit}")"
base="$(git rev-parse refs/remotes/origin/Dev)"
[[ "$tip" =~ ^[0-9a-f]{40}$ && "$base" =~ ^[0-9a-f]{40}$ ]]

# PR history records decisions even when a draft was closed or its branch deleted.
marker="<!-- nuvio-upstream-release: $tag $release_id $tip -->"
if [[ -n "$retry_pr" ]]; then
  if [[ "$prior_marker" != "$tag $release_id $tip" ]]; then
    echo 'The original release identity changed. Refusing to retry.' >&2
    exit 1
  fi
  integration="$integration-retry-$retry_pr"
  review="$review-retry-$retry_pr"
fi
for head in "$integration" "$review"; do
  previous="$(gh pr list --repo "$GITHUB_REPOSITORY" --base Dev --head "$head" --state all --limit 100 --json url,body,isCrossRepository |
    jq '[.[] | select(.isCrossRepository == false)]')"
  if jq -e 'length > 0' <<< "$previous" >/dev/null; then
    if ! jq -e --arg marker "$marker" 'all(.[]; (.body | split("\n") | index($marker)) != null)' <<< "$previous" >/dev/null; then
      echo 'The recorded upstream tag, release ID or commit differs. Manual review required.' >&2
      exit 1
    fi
    echo "Upstream release $tag was already proposed:"
    jq -r '.[].url' <<< "$previous"
    exit 0
  fi
done
if git merge-base --is-ancestor "$tip" "$base"; then
  echo "Dev already contains the commit for upstream release $tag."
  exit 0
fi

checker="$(mktemp)"; findings="$(mktemp)"; details="$(mktemp)"; body="$(mktemp)"
trap 'rm -f "$checker" "$findings" "$details" "$body"' EXIT
git show "$base:fork-maintenance/check-fork-invariants.sh" > "$checker"
git config user.name 'nuvio-fork-sync'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git checkout -q -B "$integration" "$base"

status='clean'
if ! common="$(git merge-base "$base" "$tip")"; then
  status='unrelated'
else
  git diff --no-renames --name-only "$common" "$tip" -- \
    .github fork-maintenance browser-site MPVKit .gitattributes .gitmodules gradle gradlew gradlew.bat buildSrc build-logic \
    gradle.properties settings.gradle.kts build.gradle.kts composeApp/build.gradle.kts \
    composeApp/src/desktopMain/native \
    ':(icase,glob)**/*party*' ':(icase,glob)**/*player*/**' ':(icase,glob)**/*torbox*' \
    ':(icase,glob)**/*updater*/**' ':(icase,glob)**/*installer*' ':(icase,glob)**/*hls*' \
    ':(icase,glob)**/*settings*/**' ':(icase,glob)**/*navigation*/**' ':(icase,glob)**/*sidebar*' \
    ':(glob)**/MainAppContent.kt' ':(glob)**/StreamDestination.kt' ':(glob)**/party.js' > "$findings"
  if git merge --no-ff --no-edit -m "Merge official NuvioDesktop $tag (${tip:0:12}) into fork" "$tip" > "$details" 2>&1; then
    # Run only the invariant checker from the existing fork base.
    if ! bash "$checker" > "$details" 2>&1; then
      status='invariants'
    elif [[ -s "$findings" ]]; then
      status='critical'
    fi
  elif git rev-parse --verify MERGE_HEAD >/dev/null 2>&1 && [[ -n "$(git ls-files -u)" ]]; then
    git diff --name-only --diff-filter=U > "$findings"
    git merge --abort
    status='conflict'
  else
    echo 'Merge failed without a recorded content conflict. Manual review required.' >&2
    sed -n '1,80s/^/    /p' "$details" >&2
    exit 1
  fi
fi

{
  printf '## Summary\n\nOfficial upstream release %s\n\n%s\n\n' "$tag" "$marker"
  printf '## PR type\n\n- [x] Upstream integration proposal for human review\n\n'
  printf '## Why\n\nPrepare a reviewed update from an official release while retaining fork features.\n\n'
  printf '## Desktop scope\n\nDesktop and shared changes in the upstream diff. Review platform impacts before merge.\n\n'
  printf '## Issue or approval\n\nScheduled proposal. Await maintainer review before merging.\n\n'
  printf '## UI / behavior impact\n\n- [x] Impact remains subject to human review of the upstream diff\n\n'
  printf '## Policy check\n\n- [x] No automatic merge, deployment or release\n- [x] Validation status documented below\n\n'
  printf '## Scope boundaries\n\n'
  printf 'Release: https://github.com/%s/releases/tag/%s\n\n' "$upstream_repo" "$tag"
  printf 'Upstream commit: %s\n\nFork base: %s\n\nStatus: %s\n\n' "$tip" "$base" "$status"
  if [[ -n "$retry_pr" ]]; then printf 'Manual retry of #%s.\n\n' "$retry_pr"; fi
  if [[ "$status" == clean || "$status" == critical ]]; then
    printf '%s\n' 'Merge completed locally and fork invariants passed. Review the diff and wait for the existing Windows MSI PR checks before merging.'
    if [[ "$status" == critical ]]; then
      printf '\n%s\n' 'Critical changes: review source and workflow changes before approving CI. Manual merge approval is required.'
    fi
  else
    printf '%s\n' 'Review-only PR. No upstream code is included. Resolve the issue on a separately reviewed integration branch.'
    if [[ "$status" == conflict || "$status" == invariants ]]; then
      printf '\n    Diagnostics (first 80 lines):\n'
      sed -n '1,80s/^/    /p' "$details"
    fi
  fi
  if [[ -s "$findings" ]]; then
    printf '\n    Affected paths (first 80):\n'
    sed -n '1,80s/^/    /p' "$findings"
  fi
  printf '\n%s\n' 'After review and merge, opt-in Dev CI can build an unsigned Windows MSI candidate. Signing and publication are separate.'
  printf '\n## Testing\n\nSee the integration status above. No upstream code or tests were executed by the review job. The candidate needs required PR checks before merge.\n\n'
  printf '## Screenshots / Video\n\nNo visual acceptance is claimed. Review the affected desktop areas.\n\n'
  printf '## Breaking changes\n\nUndetermined pending review of the upstream diff.\n\n'
  printf '## Linked issues\n\nNo linked issue - scheduled upstream proposal. The official release is linked above.\n'
} > "$body"

head="$integration"
title="Integrate NuvioDesktop $tag"
if [[ "$status" == critical ]]; then
  title="Critical review: integrate NuvioDesktop $tag"
elif [[ "$status" != clean ]]; then
  head="$review"
  title="Review only: NuvioDesktop $tag ($status)"
  git checkout -q -B "$review" "$base"
  report="fork-maintenance/upstream-review-$version.md"
  if [[ -e "$report" || -L "$report" ]]; then
    echo 'Review report already exists on the fork base. Manual review required.' >&2
    exit 1
  fi
  cp "$body" "$report"
  git add -- "$report"
  git commit -m "Report blocked NuvioDesktop release $tag"
fi

# Never overwrite an existing remote branch, including a manually repaired draft.
git push --force-with-lease="refs/heads/$head:" origin "HEAD:refs/heads/$head"
gh pr create --repo "$GITHUB_REPOSITORY" --base Dev --head "$head" --draft --title "$title" --body-file "$body"
if [[ "$status" != clean && "$status" != critical ]]; then exit 1; fi

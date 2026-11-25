#!/usr/bin/env bash
# An MCP PR may test a related Playground PR before its static build reaches production.
set -euo pipefail
repo=joomengine/playground
prefix="Depends on https://github.com/$repo/pull/"
mapfile -t links < <(jq -r --arg prefix "$prefix" '(.pull_request.body // "") | split("\n")[] | rtrimstr("\r") | select(startswith($prefix))' "$GITHUB_EVENT_PATH")
if (( ${#links[@]} == 0 )); then exit 0; fi
if (( ${#links[@]} != 1 )); then echo 'Specify exactly one Playground PR dependency.' >&2; exit 1; fi
number=${links[0]#"$prefix"}
[[ $number =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid Playground PR number.' >&2; exit 1; }

pr=$(gh api "repos/$repo/pulls/$number")
jq -e --arg repo "$repo" '.base.ref == "main" and .head.repo.full_name == $repo' <<< "$pr" >/dev/null
if [[ $(jq -r .merged <<< "$pr") == true ]]; then exit 0; fi
head=$(jq -er 'select(.state == "open") | .head.sha' <<< "$pr")
merge=$(jq -er .merge_commit_sha <<< "$pr")
[[ $head =~ ^[a-f0-9]{40}$ && $merge =~ ^[a-f0-9]{40}$ ]]

# Match the current upstream PR source to its own validation run and build artifact.
runs=$(gh api "repos/$repo/actions/workflows/validate.yml/runs?event=pull_request&head_sha=$head&per_page=100")
run=$(jq -er --arg repo "$repo" --arg head "$head" --argjson number "$number" '
  first(.workflow_runs[] | select(.head_sha == $head and .head_repository.full_name == $repo and
    any(.pull_requests[]; .number == $number and .head.sha == $head)) | .id)' <<< "$runs")
artifacts=$(gh api "repos/$repo/actions/runs/$run/artifacts?name=playground-static")
artifact=$(jq -ec 'first(.artifacts[] | select(.name == "playground-static" and (.expired | not)))' <<< "$artifacts") || {
  echo "Run $run has no playground-static artifact yet. Rerun this check after its build succeeds." >&2; exit 1;
}
id=$(jq -er .id <<< "$artifact")
digest=$(jq -er '.digest | capture("^sha256:(?<sha>[0-9a-f]{64})$").sha' <<< "$artifact")
archive="$RUNNER_TEMP/playground-static.zip"
gh api "repos/$repo/actions/artifacts/$id/zip" > "$archive"
echo "$digest  $archive" | sha256sum --check -
mkdir -p upstream-playground/dist
unzip -qo "$archive" -d upstream-playground/dist
jq -e --arg merge "$merge" '.sourceCommit == $merge and .runtime.kind == "release"' upstream-playground/dist/assets/manifest.json >/dev/null
echo "Paired [Playground PR #$number](https://github.com/$repo/pull/$number) at \`$head\`, [build $run](https://github.com/$repo/actions/runs/$run), archive SHA-256 \`$digest\`." >> "$GITHUB_STEP_SUMMARY"
echo 'paired=true' >> "$GITHUB_OUTPUT"

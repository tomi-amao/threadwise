#!/usr/bin/env bash
# Work out the next release version from Conventional Commits since the last tag.
#
#   next-version.sh [<commit-ish>]      (default: HEAD)
#
# Prints the next tag (e.g. v0.2.0) on stdout and exits 0, or prints nothing and exits 0
# when no commit since the last tag warrants a release. Diagnostics go to stderr.
#
# Bump rules (merge commits are ignored; their branch commits are what count):
#   major  a "!" after the type/scope (feat!: / fix(api)!:) or a "BREAKING CHANGE:" footer
#   minor  feat
#   patch  fix, perf, revert
#   none   docs, chore, ci, test, refactor, style, build, anything else
# With no earlier tag the base is v0.0.0, so the first release is v0.1.0 unless a fix-only
# history gives v0.0.1 or a breaking change gives v1.0.0.
set -euo pipefail

target="${1:-HEAD}"
last_tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "$target" 2>/dev/null || true)"

if [[ -n "$last_tag" ]]; then
  base="${last_tag#v}"
  range="${last_tag}..${target}"
else
  base="0.0.0"
  range="$target"
fi

if [[ ! "$base" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Last tag '$last_tag' is not plain vMAJOR.MINOR.PATCH" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"

bump="none"
rank() { case "$1" in major) echo 3 ;; minor) echo 2 ;; patch) echo 1 ;; *) echo 0 ;; esac; }
raise() { if (( $(rank "$1") > $(rank "$bump") )); then bump="$1"; fi; }

# One record per commit (subject, blank line, body), NUL-separated by -z.
header_re='^([a-zA-Z]+)(\([^)]*\))?(!)?:[[:space:]]'
while IFS= read -r -d '' commit; do
  subject="${commit%%$'\n'*}"
  if [[ "$subject" =~ $header_re ]]; then
    type="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    if [[ -n "${BASH_REMATCH[3]}" ]]; then raise major; fi
    case "$type" in
      feat) raise minor ;;
      fix | perf | revert) raise patch ;;
    esac
  fi
  if grep -qE '^BREAKING[ -]CHANGE:' <<<"$commit"; then raise major; fi
done < <(git log -z --no-merges --format='%B' "$range")

if [[ "$bump" == "none" ]]; then
  echo "No releasable commits (feat/fix/perf/breaking) since ${last_tag:-the beginning}" >&2
  exit 0
fi

case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac

echo "Last tag: ${last_tag:-none}; bump: $bump" >&2
echo "v${major}.${minor}.${patch}"

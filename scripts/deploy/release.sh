#!/usr/bin/env bash
# Deploys a commit to a Morfa host: ship → build on the VM → preflight (the
# settings, scripts/deploy/preflight.ts) → switch → migrate → rolling restart (api processes one by one behind Caddy's retries;
# collab nodes one by one through a drain) → status. Run it against production only deliberately; bench-ru is the
# rehearsal target.
#
#   scripts/deploy/release.sh <host> <commit> [--no-app] [--first] [--retry]
#     host     root@<ip> (or an ssh alias)
#     --first  enable the units the first time (api@1 api@2 worker collab@a collab@b render)
#     --retry  resume a run that failed (or whose job was killed) at the step that did not finish
#
# Everything after the ship runs on the host as one detached job (scripts/deploy/remote/release-job.sh: a transient unit
# morfa-release-<hash>, log and state in /srv/morfa/releases/<hash>.run/); this script polls it over short SSH calls and shows
# its log. A dropped connection is retried for MORFA_RELEASE_RECONNECT_SECONDS (default 1800) while the job goes on; past that,
# or after ctrl-c, run the same command again: it reattaches to a running job, reports a finished one, and never ships,
# switches or migrates a second time. A failed run is reported until --retry is given.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
[ $# -ge 2 ] || { sed -n '2,17p' "$0"; exit 2; }
host=$1 ref=$2; shift 2
job_args=() retry=0
while [ $# -gt 0 ]; do
  case $1 in
    --no-app|--first) job_args+=("$1"); shift ;;
    --retry) retry=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
hash=$(git rev-parse --short=9 "${ref}^{commit}")
srv=${MORFA_RELEASE_SRV:-/srv/morfa}
dir=$srv/releases/$hash
job="bash $dir/scripts/deploy/remote/release-job.sh"
poll_every=${MORFA_RELEASE_POLL_SECONDS:-3}
reconnect_for=${MORFA_RELEASE_RECONNECT_SECONDS:-1800}
# MORFA_RELEASE_SSH replaces ssh (tests/design-deploy-release.test.ts: a fake host that drops connections).
read -r -a ssh_cmd <<<"${MORFA_RELEASE_SSH:-ssh}"
SSH=("${ssh_cmd[@]}" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$host")
say() { printf '[release %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# One poll: sets state, step, size, previous, current and prints the log from $offset; non-zero when the host is unreachable.
offset=0 state="" step="" size=0 previous="" current=""
poll() {
  "${SSH[@]}" "if [ -f $dir/scripts/deploy/remote/release-job.sh ]; then $job poll $srv $hash $offset; else echo 'none - 0 - '\$(readlink $srv/current 2>/dev/null || echo -); fi" >"$tmp/poll" 2>"$tmp/poll.err" || return 1
  read -r state step size previous current <"$tmp/poll" || return 1
  [ "${quiet:-0}" = 1 ] || tail -n +2 "$tmp/poll" >&2
  offset=$size
}

# poll until it answers, for up to $reconnect_for seconds of silence.
poll_retrying() {
  local since=$SECONDS lost=0
  until poll; do
    if [ $lost = 0 ]; then say "no answer from $host ($(tail -n 1 "$tmp/poll.err" 2>/dev/null)); the job on the host goes on; retrying"; lost=1; fi
    if [ $((SECONDS - since)) -ge "$reconnect_for" ]; then
      say "no answer from $host for ${reconnect_for} s. The release goes on there (or has finished): run the same command again"
      say "to reattach; it will not ship, switch or migrate a second time"
      exit 255
    fi
    sleep "$poll_every"
  done
  [ $lost = 0 ] || say "connected again"
}

where() {
  if [ "$current" = "$dir" ]; then
    [ "$previous" != - ] || previous=none
    say "current → $current; previous: ${previous:-none} (scripts/deploy/rollback.sh $host switches back to it)"
  else
    say "current is still ${current:--} (not switched to $hash)"
  fi
}

quiet=1 poll_retrying
case $state in
  none)
    if [ "$current" = "$dir" ]; then
      say "$hash is already current on $host (released without a run record); nothing to do"
      exit 0
    fi
    say "shipping $hash to $host:$dir"
    git archive --format=tar "$hash" | "${SSH[@]}" "set -e; [ ! -e $dir.run ] || { echo '$dir.run exists: a run started meanwhile' >&2; exit 3; }; [ \"\$(readlink $srv/current)\" != $dir ] || { echo '$dir is current' >&2; exit 3; }; rm -rf $dir.tmp && install -d -o morfa -g morfa $dir.tmp && tar -x -C $dir.tmp && echo $hash >$dir.tmp/BUILD_COMMIT && chown -R morfa:morfa $dir.tmp && rm -rf $dir && mv $dir.tmp $dir" \
      || { say "shipping failed (nothing started on the host): run the same command again"; exit 1; }
    say "starting the release job on the host (morfa-release-$hash)"
    "${SSH[@]}" "$job start $srv $hash ${job_args[*]:-}" >&2 || say "no confirmation that the job started; asking the host"
    ;;
  running|starting)
    say "a run of $hash is in progress on $host (step: $step): reattaching"
    # The log's last few kilobytes, then everything new.
    offset=$(( size > 4000 ? size - 4000 : 0 )) ;;
  ok)
    say "$hash was already released on $host"
    where
    exit 0 ;;
  failed|interrupted)
    if [ $retry = 0 ]; then
      offset=$(( size > 4000 ? size - 4000 : 0 ))
      poll_retrying
      say "the last run of $hash on $host ended $state at step \"$step\" (log: $dir.run/log)"
      where
      say "fix the cause, then the same command with --retry resumes at \"$step\" (steps done are not run again)"
      exit 1
    fi
    say "resuming the run of $hash at \"$step\""
    offset=$size
    "${SSH[@]}" "$job start $srv $hash ${job_args[*]:-} --retry" >&2 || say "no confirmation that the job started; asking the host" ;;
  *) say "unexpected answer from $host: $state"; exit 1 ;;
esac

while :; do
  poll_retrying
  case $state in
    running|starting) sleep "$poll_every" ;;
    ok) say "released $hash on $host"; exit 0 ;;
    failed|interrupted)
      say "the release of $hash ended $state at step \"$step\" (log: $dir.run/log)"
      where
      say "fix the cause, then the same command with --retry resumes at \"$step\""
      exit 1 ;;
    none) say "the job did not start on $host (see above): run the same command again"; exit 1 ;;
    *) say "unexpected answer from $host: $state"; exit 1 ;;
  esac
done

#!/usr/bin/env bash
# One release as a job on the host that outlives the SSH connection. release.sh ships the
# commit to <srv>/releases/<hash>, then starts this job detached (a transient systemd unit morfa-release-<hash>, or setsid nohup
# where there is no systemd) and only polls it: a dropped connection loses the poll, never the release. The 2026-10-10 deploy
# lost its SSH connection during the cargo build, so the script died before the switch while the build finished on the host.
#
#   release-job.sh start <srv> <hash> [--first] [--no-app] [--retry]   start the job detached; returns once it runs
#   release-job.sh run <srv> <hash> [--first] [--no-app]               the job itself (what start detaches)
#   release-job.sh poll <srv> <hash> [<offset>]                        one line "state step logsize previous current", then the
#                                                                      job's log from byte <offset> to logsize
#
# The run's record is <srv>/releases/<hash>.run/: log, state ("running <pid> <step>", "ok", "failed <step>"), steps (each step
# done, in order), previous (what current pointed at before the switch: the rollback target). Steps: build → preflight → switch
# → migrate → enable (--first only) → restart → status. A step in `steps` never runs again, so a retry after a failure or a
# killed job (state "interrupted" in poll) resumes at the step that did not finish: one switch, one successful migration.
# One release at a time per host (<srv>/releases/.release.lock). Stop a running one with `systemctl stop morfa-release-<hash>`.
#
# Bash 3.2 and BSD tools are enough (tests/design-deploy-release.test.ts runs it on the Mac's gate with a fake host.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
self="$here/release-job.sh"
cmd=${1:-} srv=${2:-} hash=${3:-}
if [ -z "$cmd" ] || [ -z "$srv" ] || [ -z "$hash" ]; then sed -n '2,19p' "$0" >&2; exit 2; fi
shift 3
case $hash in *[!0-9a-f]*) echo "release-job: not a commit hash: $hash" >&2; exit 2 ;; esac
dir=$srv/releases/$hash
run=$dir.run
lock=$srv/releases/.release.lock
STEPS="build preflight switch migrate enable restart status"

say() { printf '[release %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
put_state() { printf '%s\n' "$*" >"$run/state.tmp" && mv "$run/state.tmp" "$run/state"; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && ps -p "$1" -o args= 2>/dev/null | grep -q release-job; }
done_step() { [ -f "$run/steps" ] && grep -qx "$1" "$run/steps"; }

# The state as poll reports it: running, interrupted (the job is gone without finishing: killed, host rebooted), ok, failed,
# none (no run of this commit).
state_of() { # → "<state> <step>"
  [ -f "$run/state" ] || { echo "none -"; return; }
  local word pid step
  read -r word pid step <"$run/state" || true
  case $word in
    running)
      if alive "$pid"; then echo "running ${step:--}"; return; fi
      # The job writes its final state before it exits, so it may have finished between the read above and this check: read
      # again. Still "running" now means it died without finishing (killed, the host rebooted).
      read -r word pid step <"$run/state" || true
      case $word in
        ok) echo "ok -" ;;
        failed) echo "failed ${pid:--}" ;;
        *) echo "interrupted ${step:--}" ;;
      esac ;;
    # The launcher writes "starting" and waits for the job; a "starting" left a minute later means the launcher died before the
    # job ran (its SSH session dropped): --retry starts it again.
    starting) if [ -n "$(find "$run/state" -mmin +1 2>/dev/null)" ]; then echo "interrupted start"; else echo "starting -"; fi ;;
    ok) echo "ok -" ;;
    failed) echo "failed ${pid:--}" ;;
    *) echo "interrupted -" ;;
  esac
}

poll() {
  local offset=${1:-0} size=0 state previous current
  state=$(state_of)
  [ -f "$run/log" ] && size=$(wc -c <"$run/log" | tr -d ' ')
  previous=$(cat "$run/previous" 2>/dev/null || true)
  current=$(readlink "$srv/current" 2>/dev/null || true)
  echo "$state $size ${previous:--} ${current:--}"
  if [ "$size" -gt "$offset" ]; then tail -c +"$((offset + 1))" "$run/log" | head -c "$((size - offset))"; fi
}

start() {
  local retry=0 args=()
  while [ $# -gt 0 ]; do
    case $1 in --retry) retry=1 ;; --first|--no-app) args+=("$1") ;; *) echo "release-job: unknown option $1" >&2; exit 2 ;; esac
    shift
  done
  [ -d "$dir" ] || { echo "release-job: $dir is not there (ship first)" >&2; exit 2; }
  if [ -f "$lock/pid" ] && alive "$(cat "$lock/pid")"; then
    echo "release-job: another release is running on this host ($(cat "$lock/hash" 2>/dev/null))" >&2; exit 3
  fi
  local state; state=$(state_of)
  case ${state%% *} in
    none) mkdir -p "$run" ;;
    running|starting) echo "release-job: $hash is already running" >&2; exit 3 ;;
    ok) echo "release-job: $hash was already released" >&2; exit 3 ;;
    failed|interrupted)
      [ $retry = 1 ] || { echo "release-job: the last run of $hash ended $state; --retry resumes it" >&2; exit 3; }
      printf '\n' >>"$run/log"; say "retry: resuming after $({ tr '\n' ' ' <"$run/steps"; } 2>/dev/null)" >>"$run/log" ;;
  esac
  put_state starting
  rm -rf "$lock" # stale: its job is gone (checked above)
  local unit="" child=""
  if [ "${MORFA_RELEASE_DETACH:-}" != setsid ] && command -v systemd-run >/dev/null && [ -d /run/systemd/system ]; then
    unit="morfa-release-$hash"
    systemctl reset-failed "$unit.service" 2>/dev/null || true
    systemd-run --quiet --collect --unit "$unit" --description "Morfa release $hash" \
      /bin/bash "$self" run "$srv" "$hash" ${args[@]+"${args[@]}"}
  elif command -v setsid >/dev/null; then
    setsid nohup bash "$self" run "$srv" "$hash" ${args[@]+"${args[@]}"} </dev/null >/dev/null 2>&1 &
    child=$!
  else
    nohup bash "$self" run "$srv" "$hash" ${args[@]+"${args[@]}"} </dev/null >/dev/null 2>&1 &
    child=$!
  fi
  # Wait while the job is on its way: no fixed limit for a slow start (a loaded host), only the job's own end (two minutes as a
  # backstop). The job writes "running" first thing and its final state before it exits, so a job gone with the state still
  # "starting" never ran.
  spawned_gone() {
    if [ -n "$child" ]; then
      if kill -0 "$child" 2>/dev/null; then return 1; fi
      return 0
    fi
    case $(systemctl show -p ActiveState --value "$unit.service" 2>/dev/null) in active|activating|reloading|deactivating) return 1 ;; *) return 0 ;; esac
  }
  local started=$SECONDS
  while :; do
    case $(state_of) in starting*) ;; *) echo "release-job: $hash started"; return 0 ;; esac
    if spawned_gone || [ $((SECONDS - started)) -ge 120 ]; then
      # Read once more: the job may have written its state just before it was seen gone.
      case $(state_of) in starting*) ;; *) echo "release-job: $hash started"; return 0 ;; esac
      put_state failed start
      echo "release-job: the job did not start (journalctl -u morfa-release-$hash)" >&2
      exit 1
    fi
    sleep 0.1
  done
}

job() {
  local first=0 build_args=()
  while [ $# -gt 0 ]; do
    case $1 in --first) first=1 ;; --no-app) build_args+=(--no-app) ;; esac
    shift
  done
  exec >>"$run/log" 2>&1
  step=lock
  trap job_exit EXIT
  trap 'exit 143' TERM INT
  mkdir "$lock" 2>/dev/null || { say "another release holds $lock"; exit 3; }
  echo $$ >"$lock/pid"; echo "$hash" >"$lock/hash"
  local host_sh="$dir/scripts/deploy/remote/host.sh"
  for step in $STEPS; do
    if done_step "$step"; then continue; fi
    put_state running $$ "$step"
    case $step in
      build)
        say "── build (scripts/deploy/build.sh as morfa)"
        ( cd "$dir" && sudo -u morfa -H env CARGO_TARGET_DIR="$srv/target" bash scripts/deploy/build.sh ${build_args[@]+"${build_args[@]}"} ) ;;
      preflight) say "── preflight"; bash "$host_sh" preflight "$dir" ;;
      switch)
        say "── switch"
        if [ ! -f "$run/previous" ]; then
          if [ -L "$srv/current" ]; then readlink -f "$srv/current"; fi >"$run/previous"
        fi
        bash "$host_sh" switch "$dir" ;;
      migrate) say "── migrate"; bash "$host_sh" migrate ;;
      enable)
        [ $first = 1 ] || continue
        say "── enable the units (--first)"
        systemctl enable morfa-api@1 morfa-api@2 morfa-worker morfa-collab@a morfa-collab@b morfa-render
        systemctl start morfa-render morfa-collab@a morfa-collab@b morfa-api@1 morfa-api@2 morfa-worker ;;
      restart) say "── rolling restart"; bash "$host_sh" restart ;;
      status) say "── status"; bash "$host_sh" status ;;
    esac
    echo "$step" >>"$run/steps"
  done
  step=-
  say "released $hash"
  report
}

job_exit() {
  local rc=$?
  # The lock goes first: whoever sees the final state may start the next release at once (release.sh exits on "ok", and the
  # next release's launcher must not find this job's lock still held).
  if [ "$(cat "$lock/pid" 2>/dev/null)" = $$ ]; then rm -rf "$lock"; fi
  if [ $rc = 0 ]; then put_state ok; else put_state failed "$step"; say "failed at $step (exit $rc)"; report; fi
}

# Where the host stands, for the log's end (and so for release.sh's output).
report() {
  if done_step switch; then
    say "current → $(readlink "$srv/current" 2>/dev/null); previous: $(grep . "$run/previous" 2>/dev/null || echo none) (scripts/deploy/rollback.sh <host> switches back to it)"
  else
    say "not switched: current is still $(readlink "$srv/current" 2>/dev/null || echo none)"
  fi
}

case $cmd in
  start) start "$@" ;;
  run) job "$@" ;;
  poll) poll "${1:-0}" ;;
  *) sed -n '2,19p' "$0" >&2; exit 2 ;;
esac

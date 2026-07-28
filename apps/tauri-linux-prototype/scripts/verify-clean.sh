#!/bin/bash
set -euo pipefail

app_image="/bundle path/应用 包/Silksong Git 原型.AppImage"
evidence_dir="/evidence"
workspace_root="/workspace root/含 空格与中文"
tracer_evidence="${evidence_dir}/clean-tracer.json"
close_evidence="${evidence_dir}/clean-close-drain.json"

if command -v node >/dev/null 2>&1 || command -v git >/dev/null 2>&1; then
  echo "clean image unexpectedly contains system Node.js or Git" >&2
  exit 1
fi

{
  echo "node=absent"
  echo "git=absent"
  echo "network=disabled-by-podman-run"
  echo "display=Xvfb"
  echo "bundle=${app_image}"
  cat /etc/os-release
} >"${evidence_dir}/clean-environment.txt"

Xvfb :99 -screen 0 1280x900x24 >"${evidence_dir}/xvfb.log" 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
trap 'kill ${xvfb_pid} >/dev/null 2>&1 || true' EXIT

sleep 1
APPIMAGE_EXTRACT_AND_RUN=1 \
SILKSONG_GIT_PROTOTYPE_AUTORUN=tracer \
SILKSONG_GIT_PROTOTYPE_WORKSPACE_ROOT="${workspace_root}" \
SILKSONG_GIT_PROTOTYPE_TRACER_EVIDENCE="${tracer_evidence}" \
"${app_image}" >"${evidence_dir}/tracer-app.log" 2>&1 &
tracer_pid=$!
tracer_window="$(xdotool search --sync --name 'Silksong Git packaging tracer' | tail -1)"

for _ in $(seq 1 45); do
  [[ -s "${tracer_evidence}" ]] && break
  sleep 1
done
[[ -s "${tracer_evidence}" ]]
grep -q '"byteExactRestore": true' "${tracer_evidence}"
grep -q '"reportedAs": "unexpectedExit"' "${tracer_evidence}"
grep -q '"bundledGitRunningBefore": true' "${tracer_evidence}"
grep -q '"bundledGitExecutableMatched": true' "${tracer_evidence}"
grep -q '"membersAfter": \[\]' "${tracer_evidence}"
xwd -silent -root -out "${evidence_dir}/clean-visible-tracer.xwd"
kill "${tracer_pid}" >/dev/null 2>&1 || true
wait "${tracer_pid}" >/dev/null 2>&1 || true

APPIMAGE_EXTRACT_AND_RUN=1 \
SILKSONG_GIT_PROTOTYPE_AUTORUN=close-drain \
SILKSONG_GIT_PROTOTYPE_WORKSPACE_ROOT="${workspace_root}" \
SILKSONG_GIT_PROTOTYPE_CLOSE_EVIDENCE="${close_evidence}" \
"${app_image}" >"${evidence_dir}/close-app.log" 2>&1 &
close_pid=$!
close_window="$(xdotool search --sync --name 'Silksong Git packaging tracer' | tail -1)"

for _ in $(seq 1 45); do
  [[ -s "${close_evidence}" ]] && break
  sleep 1
done
[[ -s "${close_evidence}" ]]
grep -q '"requestedWhileActive": true' "${close_evidence}"
grep -q '"operationCompletedBeforeStopped": true' "${close_evidence}"
grep -q '"stoppedEventSeen": true' "${close_evidence}"
wait "${close_pid}"

if pgrep -f 'silksong-git-sidecar|private-git/bin/git' >/dev/null 2>&1; then
  echo "sidecar or bundled Git descendant survived verification" >&2
  ps -ef >&2
  exit 1
fi

echo "clean AppImage tracer and close-drain verification passed"

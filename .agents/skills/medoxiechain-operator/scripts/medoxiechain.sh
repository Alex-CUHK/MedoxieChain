#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
GROUP=${1:-}
ACTION=${2:-}

case "$GROUP:$ACTION" in
  chain:status|rollup:status|supernode:list|contract:list|contract:deployments|contract:compile)
    ;;
  balance:l1|balance:l2|send:l1|send:l2)
    ;;
  contract:deploy|contract:read|contract:write)
    NETWORK=${3:-}
    case "$NETWORK" in
      l1|l2) ;;
      *) echo "ERROR: contract network must be l1 or l2" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "ERROR: action is not allowed by the MedoxieChain OpenClaw policy" >&2
    exit 2
    ;;
esac

exec "$ROOT/medoxie" "$@"

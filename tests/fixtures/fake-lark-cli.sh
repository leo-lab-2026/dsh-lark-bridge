#!/bin/sh
# Fake lark-cli for dsh-lark-bridge tests. Behavior is selected by
# $FAKE_LARK_CLI_MODE (default: log). All lark-cli arguments are ignored —
# the real CLI contract is exercised against the real binary in manual E2E.
mode="${FAKE_LARK_CLI_MODE:-log}"
case "$mode" in
  log)
    for arg in "$@"; do
      printf '%s\n' "$arg" >> "${FAKE_LARK_LOG:?FAKE_LARK_LOG not set}"
    done
    printf '%s\n' '---' >> "$FAKE_LARK_LOG"
    printf '{"ok":true,"identity":"bot","data":{}}\n'
    exit 0
    ;;
  fail)
    printf '{"ok":false,"error":{"type":"api","subtype":"invalid_param","code":12345,"message":"bad request","hint":"check the docs"}}\n' >&2
    exit 3
    ;;
  slow)
    exec sleep 30
    ;;
  noise)
    head -c 200000 /dev/zero | tr '\0' 'x'
    printf '{"ok":true,"identity":"bot"}\n'
    exit 0
    ;;
  auth-status)
    printf '{"appId":"cli_test","brand":"feishu","identity":"bot","identities":{"bot":{"status":"ready","available":true,"message":"Bot identity: ready"},"user":{"available":false}}}\n'
    exit 0
    ;;
  auth-status-bad)
    printf '{"appId":"cli_test","brand":"feishu","identity":"bot","identities":{"bot":{"status":"missing","available":false,"message":"Bot identity: missing","hint":"run: lark-cli config init"},"user":{"available":false}}}\n'
    exit 0
    ;;
  consume)
    # Dispatches by first arg so ONE env mode can serve the whole setup flow:
    # auth status → ready envelope; im +messages-send → success envelope;
    # event consume → ready marker + captured event + stay alive.
    if [ "$1" = "auth" ]; then
      printf '{"appId":"cli_test","brand":"feishu","identity":"bot","identities":{"bot":{"status":"ready","available":true,"message":"Bot identity: ready"},"user":{"available":false}}}\n'
      exit 0
    fi
    if [ "$1" != "event" ]; then
      printf '{"ok":true,"identity":"bot","data":{}}\n'
      exit 0
    fi
    printf '[event] ready event_key=im.message.receive_v1\n' >&2
    sleep 0.2
    printf '%s\n' "${FAKE_LARK_EVENT:-}"
    exec sleep 30
    ;;
  *)
    printf '{"ok":false,"error":{"type":"usage","message":"unknown mode"}}\n' >&2
    exit 2
    ;;
esac

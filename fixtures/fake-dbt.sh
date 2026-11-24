#!/bin/sh
# Stands in for dbt in src/worker.test.ts, answering the way dbt v2 (Fusion) does: `show`
# echoes FAKE_GREETING (from fixtures/workspace/.env) and the folder it runs in.
case "$1" in
  --version) echo "dbt-fusion 2.0.0-test" ;;
  show)
    printf '{"info":{"name":"ShowNode","level":"info"},"data":{"columns":["greeting","folder"],"preview":"[{\\"greeting\\":\\"%s\\",\\"folder\\":\\"%s\\"}]"}}\n' "$FAKE_GREETING" "$(basename "$PWD")"
    ;;
  parse)
    echo '{"info":{"name":"Generic","level":"error","msg":"error: dbt1060: Ignored unexpected key"}}'
    exit 1
    ;;
esac

#!/usr/bin/env bash
# Використання: bash run_pipeline.sh process.csv "Назва пулу" output.drawio
# Скрипти шукаються поруч із цим файлом — запускати можна з будь-якої папки.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV="$1"; POOL="${2:-Process}"; OUT="${3:-diagram.drawio}"
python3 "$SCRIPT_DIR/table_to_bpmn.py" "$CSV" /tmp/_sem.bpmn "$POOL"
node "$SCRIPT_DIR/layout_step.mjs" /tmp/_sem.bpmn /tmp/_layouted.bpmn
python3 "$SCRIPT_DIR/bpmn_di_to_drawio.py" /tmp/_layouted.bpmn "$OUT"
echo "Готово: $OUT"

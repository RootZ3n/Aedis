#!/bin/bash
# Aedis Cost Summary — reads memory.json, prints cost stats

MEMORY="/mnt/ai/aedis/.aedis/memory.json"

if [[ ! -f "$MEMORY" ]]; then
  echo "Error: ${MEMORY} not found"
  exit 1
fi

total_tasks=$(jq '.recentTasks | length' "$MEMORY")
total_cost=$(jq '[.recentTasks[].cost] | add' "$MEMORY")
avg_cost=$(jq '[.recentTasks[].cost] | add / length' "$MEMORY")
most_expensive=$(jq '.recentTasks | sort_by(.cost) | last | {prompt: .prompt, cost: .cost}' "$MEMORY")
recent_files=$(jq '[.recentTasks[].filesTouched[]?] | unique | .[-5:] | reverse' "$MEMORY")

echo "=== Aedis Cost Summary ==="
echo ""
echo "Total tasks:       ${total_tasks}"
printf "Total cost:        \$%.6f\n" "$total_cost"
printf "Avg cost/task:     \$%.6f\n" "$avg_cost"
echo ""
echo "Most expensive task:"
echo "$most_expensive" | jq -r '"  Prompt: \(.prompt)\n  Cost:  $\(.cost)"'
echo ""
echo "Most recently touched files:"
echo "$recent_files" | jq -r '.[] | "  - \(.)"'

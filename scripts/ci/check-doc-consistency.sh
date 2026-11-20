#!/usr/bin/env bash
# 文档一致性闸：防止「同一事实散在多份文档、改一处漂三处」的那类回归。
#
# 为什么需要它：这个仓库踩过两次同类问题——退款口径（原路/自动退）和巡检范围
# （只扫 processing）都是「代码与脚本改了、文档还留着旧说法」，而两次都没人发现。
# 单测闸覆盖不到 Markdown，所以单独加一道。
#
# 用法：scripts/ci/check-doc-consistency.sh        # 退出码 0 = 通过，1 = 有违规
# 规则写在 RULES 区，加规则时请同时加一条自测说明。
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 2

PLAYBOOK=docs/support-playbook.md
RUNBOOK=docs/ops-runbook.md

fail=0
check() {  # check <描述> <命令...>
  local desc="$1"; shift
  if "$@"; then
    printf 'ok    %s\n' "$desc"
  else
    printf 'FAIL  %s\n' "$desc" >&2
    fail=1
  fi
}

# ---- 规则 1：不再出现「N 个工作日到账」这类退款时效承诺 ----
# 例外：口径守则本身会引用旧说法提醒「不要出现」。
hits=$(grep -rn "个工作日" README.md docs/*.md 2>/dev/null \
        | grep -v "不要出现" | grep -v "不承诺工作日" | grep -v "禁止任何" | grep -v "不许说" | grep -v "红线" || true)
if [ -n "${hits}" ]; then printf '%s\n' "${hits}" >&2; fi
check "无『N 个工作日到账』类退款时效承诺" test -z "${hits}"

# ---- 规则 2：不再对外宣称 XorPay 自动退款（渠道已不注册） ----
hits=$(grep -rn "XorPay 支持自动\|自动原路退款" README.md docs/*.md || true)
if [ -n "${hits}" ]; then printf '%s\n' "${hits}" >&2; fi
check "无『XorPay 支持自动原路退款』这类失效承诺" test -z "${hits}"

# ---- 规则 3：退款必须写明「100% 人工」 ----
check "客服剧本声明退款 100% 人工" grep -q "退款 100% 人工" "${PLAYBOOK}"

# ---- 规则 4：退款时限只维护在巡检说明中 ----
for threshold in '24 小时' '48 小时'; do
  check "订单巡检含内部时限「${threshold}」" grep -qF -- "${threshold}" "${RUNBOOK}"
done
check "客服处理指向订单巡检" grep -qF '(ops-runbook.md#订单巡检)' "${PLAYBOOK}"

# ---- 规则 5：值班人必须被写明（不许只写「人盯」） ----
check "客服剧本写明值班人" grep -q "值班人" "${PLAYBOOK}"
check "运维手册写明值班人" grep -q "值班人" "${RUNBOOK}"

# ---- 规则 6：退款时限必须有机器提醒（D 类）且状态取值已标注 ----
check "运维手册含 D 类（退款超时巡检）" grep -q "D 退款超时" "${RUNBOOK}"
check "巡检区分新旧退款状态" grep -q 'D 退款超时.*`review`.*旧.*`processing`' "${RUNBOOK}"

# ---- 规则 7：巡检不得退回「只扫 processing」的旧口径 ----
# 允许出现 processing，但同一处不许再说「crypto 单停在 processing」。
hits=$(grep -rn "停在 \`processing\`\|停在 processing" docs/*.md 2>/dev/null || true)
if [ -n "${hits}" ]; then printf '%s\n' "${hits}" >&2; fi
check "无『crypto 单停在 processing』的旧判据" test -z "${hits}"

if [ "${fail}" -ne 0 ]; then
  printf '\n文档一致性闸未通过：先按上面 FAIL 行改文档，再改本脚本的规则。\n' >&2
  exit 1
fi
printf '\n全部通过。\n'

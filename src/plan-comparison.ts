// Product capabilities checked against https://learn.chatgpt.com/docs/pricing.
// Pro quota multiples (relative to Plus) follow the operator-provided 10 / 20 / 50 tiers.
// Quota windows refer to Work / Codex, not every ChatGPT model's message limits.
// Audience and example tasks below are editorial recommendations, not usage guarantees.
export const planComparisons: Record<
  string,
  { audience: string; scenarios: string; contents: string[] }
> = {
  go: {
    audience: '刚开始使用 AI、预算有限的轻量用户',
    scenarios: '日常问答、学习辅助，偶尔处理简单代码。',
    contents: ['GPT-6 Luna 模型', '日常问答与学习辅助', 'Codex 轻量编程任务'],
  },
  plus: {
    audience: '经常用 AI 学习、写作或辅助编程的个人用户',
    scenarios: '写作与资料整理，每周安排几次集中编程。',
    contents: [
      '可访问 OpenAI 高阶模型，如 GPT-6 Astra',
      '支持 ChatGPT Work 与 Codex',
      'Work / Codex 有 5 小时限额',
    ],
  },
  pro5: {
    audience: '已形成固定 AI 工作习惯的开发者与创作者',
    scenarios: '需要连续工作，希望摆脱 5 小时窗口的等待。',
    contents: [
      '10 倍 Plus 额度（Work / Codex）',
      'Work / Codex 无 5 小时限额',
      '包含 Plus 模型与功能',
    ],
  },
  pro20: {
    audience: '把 AI 作为主要工作工具的专业用户',
    scenarios: '持续进行开发、研究或多项目工作，按实际用量选择 Pro 档位。',
    contents: [
      '20 倍 Plus 额度（Work / Codex）',
      'Work / Codex 无 5 小时限额',
      '包含 Plus 模型与功能',
    ],
  },
  promax: {
    audience: '任务密集、尤其看重响应速度的重度用户',
    scenarios: '密集编程与频繁迭代，希望使用 Ultrafast 模式。',
    contents: [
      '50 倍 Plus 额度（Work / Codex）',
      'Work / Codex 无 5 小时限额',
      '可使用 Ultrafast 模式',
    ],
  },
}

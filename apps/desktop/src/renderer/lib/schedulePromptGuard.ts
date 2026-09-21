// Detects prompts that try to set the scheduled task's time/cycle in prose.
// The time belongs in the schedule fields (runAt / cronExpr), not in the prompt.
const SCHEDULE_INTENT_PATTERNS: RegExp[] = [
  // Recurring intervals in Chinese.
  /每天|每小时|每分钟|每周[一二三四五六日天]?|每月|每年|每隔/,
  /工作日|双休日|周末|星期[一二三四五六日天]|礼拜[一二三四五六日天]?/,
  // Explicit scheduling wording (avoid bare 周期: 生命周期 etc. are false positives).
  /定时|周期(?:性)?(?:执行|运行|触发|提醒|任务|调度)/,
  // Clock time in Chinese, e.g. 早上9点 / 下午3点半 / 18点05分.
  /[零一二两三四五六七八九十\d]{1,2}\s*[点时](?:半|钟|[:：]?\d{1,2}\s*分?)(?!\.)/,
  /(?:早上|上午|下午|晚上|凌晨|中午|今晚|明早|明晚)\s*[零一二两三四五六七八九十\d]{1,2}\s*点/,
  // 24-hour clock like 9:30 / 18：05.
  /(?<![\d:：])\d{1,2}[:：]\d{2}(?![\d:：])/,
  // English scheduling wording.
  /\bcron\b/i,
  /\b(?:daily|hourly|weekly|monthly|weekdays?|weekends?)\b/i,
  /\bevery\s+(?:day|hour|week|month|minute|morning|afternoon|evening|night|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s*(?:minutes?|hours?|days?|weeks?|months?))\b/i,
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
];

export function promptContainsScheduleIntent(prompt: string): boolean {
  return SCHEDULE_INTENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

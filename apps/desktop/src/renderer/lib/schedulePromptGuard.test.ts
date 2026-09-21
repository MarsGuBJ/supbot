import { describe, expect, it } from "vitest";
import { promptContainsScheduleIntent } from "./schedulePromptGuard";

describe("promptContainsScheduleIntent", () => {
  it("flags Chinese recurring intervals", () => {
    expect(promptContainsScheduleIntent("每天早上9点提醒我喝水")).toBe(true);
    expect(promptContainsScheduleIntent("每小时同步一次数据")).toBe(true);
    expect(promptContainsScheduleIntent("每周一生成周报")).toBe(true);
    expect(promptContainsScheduleIntent("每隔30分钟检查一次")).toBe(true);
    expect(promptContainsScheduleIntent("工作日早上提醒我打卡")).toBe(true);
  });

  it("flags Chinese scheduling wording and clock times", () => {
    expect(promptContainsScheduleIntent("定时检查服务器状态")).toBe(true);
    expect(promptContainsScheduleIntent("周期性执行备份任务")).toBe(true);
    expect(promptContainsScheduleIntent("下午3点半提醒开会")).toBe(true);
    expect(promptContainsScheduleIntent("18:05 提醒下班")).toBe(true);
  });

  it("flags English scheduling wording", () => {
    expect(promptContainsScheduleIntent("Run this report daily")).toBe(true);
    expect(promptContainsScheduleIntent("check the build every 2 hours")).toBe(true);
    expect(promptContainsScheduleIntent("remind me at 9pm")).toBe(true);
    expect(promptContainsScheduleIntent("use cron 0 9 * * 1-5")).toBe(true);
  });

  it("allows prompts without schedule intent", () => {
    expect(promptContainsScheduleIntent("总结一下今天的会议纪要")).toBe(false);
    expect(promptContainsScheduleIntent("分析这个项目的生命周期")).toBe(false);
    expect(promptContainsScheduleIntent("Write a summary of the design doc")).toBe(false);
    expect(promptContainsScheduleIntent("整理生成的文件")).toBe(false);
  });
});

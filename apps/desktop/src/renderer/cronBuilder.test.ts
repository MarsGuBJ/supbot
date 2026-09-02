import { describe, expect, it } from "vitest";
import {
  CRON_FIELD_SPECS,
  cronFieldValues,
  cronFromSelections,
  emptyCronSelections,
  selectionsFromCron,
} from "./lib/cronBuilder";

describe("cronBuilder", () => {
  it("maps an empty selection to *", () => {
    expect(cronFromSelections(emptyCronSelections())).toBe("* * * * *");
  });

  it("joins multi-value selections in field order", () => {
    const selections = emptyCronSelections();
    selections[0] = [30, 0]; // minute
    selections[1] = [9]; // hour
    selections[3] = [12, 1]; // month
    selections[4] = [5, 1, 3]; // week
    expect(cronFromSelections(selections)).toBe("0,30 9 * 1,12 1,3,5");
  });

  it("drops out-of-range values and dedupes", () => {
    const selections = emptyCronSelections();
    selections[1] = [25, 9, 9, -1];
    expect(cronFromSelections(selections)).toBe("* 9 * * *");
  });

  it("round-trips simple expressions", () => {
    expect(cronFromSelections(selectionsFromCron("0 9 * * 1-5".replace("1-5", "1,5")))).toBe("0 9 * * 1,5");
    expect(cronFromSelections(selectionsFromCron("*/10 9 * * *"))).toBe("* 9 * * *");
    expect(cronFromSelections(selectionsFromCron(undefined))).toBe("* * * * *");
  });

  it("parses comma lists into selections", () => {
    const selections = selectionsFromCron("0,30 9 1,15 6 0,6");
    expect(selections).toEqual([[0, 30], [9], [1, 15], [6], [0, 6]]);
  });

  it("exposes cron spec ranges and week display order", () => {
    expect(CRON_FIELD_SPECS.map((spec) => spec.key)).toEqual(["minute", "hour", "day", "month", "week"]);
    expect(cronFieldValues(CRON_FIELD_SPECS[0])).toHaveLength(60);
    expect(cronFieldValues(CRON_FIELD_SPECS[4])).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

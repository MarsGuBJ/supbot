/**
 * Pure helpers for the 5-field cron builder (minute hour day-of-month month
 * day-of-week), matching the runtime's cronMatches in
 * packages/runtime/src/runtime.ts. Dropdown selections are lists of numbers;
 * an empty selection means "*" (every value).
 */

export type CronFieldKey = "minute" | "hour" | "day" | "month" | "week";

export interface CronFieldSpec {
  key: CronFieldKey;
  min: number;
  max: number;
  /** Select display order; defaults to ascending from min. */
  order?: number[];
}

export const CRON_FIELD_SPECS: CronFieldSpec[] = [
  { key: "minute", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "day", min: 1, max: 31 },
  { key: "month", min: 1, max: 12 },
  // cron day-of-week: 0 = Sunday. Show Monday first for friendlier reading.
  { key: "week", min: 0, max: 6, order: [1, 2, 3, 4, 5, 6, 0] },
];

export function cronFieldValues(spec: CronFieldSpec): number[] {
  if (spec.order) {
    return spec.order;
  }
  return Array.from({ length: spec.max - spec.min + 1 }, (_unused, index) => spec.min + index);
}

/** Selections in spec order (minute, hour, day, month, week). */
export type CronSelections = number[][];

export function emptyCronSelections(): CronSelections {
  return CRON_FIELD_SPECS.map(() => []);
}

/**
 * Parse a 5-field cron expression into dropdown selections. Each field must be
 * "*" or a comma list of plain integers inside the field range; anything more
 * exotic (ranges, steps) is treated as "not representable" and yields an empty
 * selection for that field.
 */
export function selectionsFromCron(expr: string | undefined): CronSelections {
  const parts = expr?.trim().split(/\s+/) || [];
  return CRON_FIELD_SPECS.map((spec, index) => {
    const part = parts[index];
    if (!part || part === "*") {
      return [];
    }
    const tokens = part.split(",");
    const values: number[] = [];
    for (const token of tokens) {
      if (!/^\d+$/.test(token)) {
        return [];
      }
      const value = Number(token);
      if (value < spec.min || value > spec.max) {
        return [];
      }
      values.push(value);
    }
    return values;
  });
}

/** Join dropdown selections into a 5-field cron expression. */
export function cronFromSelections(selections: CronSelections): string {
  return CRON_FIELD_SPECS.map((spec, index) => {
    const values = [...new Set(selections[index] || [])].filter(
      (value) => value >= spec.min && value <= spec.max,
    );
    return values.length ? values.sort((a, b) => a - b).join(",") : "*";
  }).join(" ");
}

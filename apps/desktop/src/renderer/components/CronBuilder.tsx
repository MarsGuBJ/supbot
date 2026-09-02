import { useMemo } from "react";
import { Checkbox, Select } from "antd";
import {
  CRON_FIELD_SPECS,
  cronFieldValues,
  cronFromSelections,
  selectionsFromCron,
  type CronFieldSpec,
} from "../lib/cronBuilder";
import type { Translator } from "../lib/types";

const FIELD_LABEL_KEYS: Record<CronFieldSpec["key"], string> = {
  minute: "Minute",
  hour: "Hour",
  day: "Day",
  month: "Month",
  week: "Week",
};

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fieldOptions(spec: CronFieldSpec, t: Translator) {
  return cronFieldValues(spec).map((value) => ({
    value,
    label: spec.key === "week" ? t(WEEKDAY_KEYS[value]) : String(value),
  }));
}

/**
 * Friendly 5-field cron editor: one multi-select dropdown (with checkbox
 * options) per field — minute/hour/day/month/week. Empty selection means "*".
 * Used as an antd Form control via value/onChange of the cron expression.
 */
export function CronBuilder({
  value,
  onChange,
  t,
}: {
  value?: string;
  onChange?: (expr: string) => void;
  t: Translator;
}) {
  const selections = useMemo(() => selectionsFromCron(value), [value]);
  const expression = cronFromSelections(selections);

  const updateField = (index: number, next: number[]) => {
    const nextSelections = selections.map((current, i) => (i === index ? next : current));
    onChange?.(cronFromSelections(nextSelections));
  };

  return (
    <div className="cron-builder">
      <div className="cron-builder-fields">
        {CRON_FIELD_SPECS.map((spec, index) => {
          const selected = selections[index];
          return (
            <label className="cron-builder-field" key={spec.key}>
              <span className="cron-builder-label">{t(FIELD_LABEL_KEYS[spec.key])}</span>
              <Select
                mode="multiple"
                allowClear
                showSearch={false}
                maxTagCount={2}
                placeholder={t("Every")}
                style={{ width: "100%" }}
                options={fieldOptions(spec, t)}
                value={selected}
                onChange={(next) => updateField(index, next)}
                optionRender={(option) => (
                  <Checkbox checked={selected.includes(Number(option.value))} style={{ pointerEvents: "none" }}>
                    {option.label}
                  </Checkbox>
                )}
              />
            </label>
          );
        })}
      </div>
      <div className="cron-builder-preview">{t("Cron {expr}", { expr: expression })}</div>
    </div>
  );
}

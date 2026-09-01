import { useState } from "react";
import { CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { Button, Checkbox, Input, Radio, Tag } from "antd";
import type { ChatMessageBlock, UserQuestionAnswer } from "@supbot/shared";

export type QuestionMessageBlock = Extract<ChatMessageBlock, { type: "question" }>;

export function QuestionBlock({
  block,
  t,
}: {
  block: QuestionMessageBlock;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  if (block.status === "canceled") {
    return (
      <div className="question-card is-canceled">
        <div className="tool-card-head">
          <CloseCircleOutlined />
          <strong>{t("Question")}</strong>
          <Tag>{t("canceled")}</Tag>
        </div>
        {block.questions.map((item, index) => (
          <div className="question-item" key={`${block.questionId}-c-${index}`}>
            <div className="question-text">{item.question}</div>
          </div>
        ))}
      </div>
    );
  }

  if (block.status === "answered") {
    return (
      <div className="question-card is-answered">
        <div className="tool-card-head">
          <CheckCircleOutlined />
          <strong>{t("Question")}</strong>
          <Tag color="green">{t("answered")}</Tag>
        </div>
        {block.questions.map((item, index) => {
          const answer = block.answers?.find((entry) => entry.question === item.question);
          return (
            <div className="question-item" key={`${block.questionId}-a-${index}`}>
              <div className="question-text">{item.question}</div>
              <div className="question-answers">
                {answer?.answers.length ? (
                  answer.answers.map((entry, entryIndex) => <Tag key={`${index}-${entryIndex}`}>{entry}</Tag>)
                ) : (
                  <span className="muted">{t("(no answer)")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const canSubmit = block.questions.every((item, index) => item.multiSelect || (selections[index]?.length ?? 0) === 1);
  const submit = async () => {
    setSubmitting(true);
    try {
      const answers: UserQuestionAnswer[] = block.questions.map((item, index) => {
        const picked = selections[index] || [];
        const note = (notes[index] || "").trim();
        return { question: item.question, answers: note ? [...picked, note] : picked };
      });
      await window.supbot.answerUserQuestion(block.questionId, answers);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="question-card is-pending">
      <div className="tool-card-head">
        <QuestionCircleOutlined />
        <strong>{t("Question")}</strong>
        <Tag color="gold">{t("pending")}</Tag>
      </div>
      {block.questions.map((item, index) => (
        <div className="question-item" key={`${block.questionId}-q-${index}`}>
          <div className="question-text">{item.question}</div>
          <div className="question-options">
            {item.multiSelect ? (
              <Checkbox.Group
                value={selections[index] || []}
                onChange={(values) => setSelections((current) => ({ ...current, [index]: values as string[] }))}
              >
                {item.options.map((option) => (
                  <Checkbox key={option.label} value={option.label}>
                    <span>{option.label}</span>
                    {option.description ? <small className="muted"> {option.description}</small> : null}
                  </Checkbox>
                ))}
              </Checkbox.Group>
            ) : (
              <Radio.Group
                value={selections[index]?.[0]}
                onChange={(event) => setSelections((current) => ({ ...current, [index]: [event.target.value] }))}
              >
                {item.options.map((option) => (
                  <Radio key={option.label} value={option.label}>
                    <span>{option.label}</span>
                    {option.description ? <small className="muted"> {option.description}</small> : null}
                  </Radio>
                ))}
              </Radio.Group>
            )}
          </div>
          <Input
            className="question-note"
            size="small"
            placeholder={t("Add a note (optional)")}
            value={notes[index] || ""}
            onChange={(event) => setNotes((current) => ({ ...current, [index]: event.target.value }))}
          />
        </div>
      ))}
      <div className="question-actions">
        <Button size="small" type="primary" loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {t("Submit answers")}
        </Button>
      </div>
    </div>
  );
}

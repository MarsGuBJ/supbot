import type { FormEvent, ReactElement, ReactNode } from "react";
import { cloneElement, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Inbox, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { CommandReceipt } from "../types";
import { statusLabel } from "../utils";

export function PageHeader({
  eyebrow,
  title,
  meta,
  action,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {meta ? <p>{meta}</p> : null}
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className="data-state loading-state" role="status" aria-label="正在加载">
      <LoaderCircle className="spin" size={20} />
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="data-state error-state" role="alert">
      <AlertTriangle size={22} />
      <div>
        <strong>数据暂时无法读取</strong>
        <p>{error.message}</p>
      </div>
      <button className="button secondary compact" type="button" onClick={onRetry}>
        <RefreshCw size={15} />
        重试
      </button>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="data-state empty-state">
      <Inbox size={24} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

export function CommandNotice({ receipt, onClose }: { receipt: CommandReceipt; onClose: () => void }) {
  return (
    <div className="command-notice" role="status">
      <CheckCircle2 size={18} />
      <div>
        <strong>命令已受理</strong>
        <span>命令号 {receipt.commandId}</span>
      </div>
      <StatusBadge label={statusLabel(receipt.status)} tone={commandTone(receipt.status)} />
      <button className="icon-button quiet" type="button" aria-label="关闭通知" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

export function Dialog({
  open,
  title,
  subtitle,
  submitting,
  submitLabel,
  error,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  submitting: boolean;
  submitLabel: string;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(submitting);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    submittingRef.current = submitting;
    onCloseRef.current = onClose;
  }, [onClose, submitting]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) {
        return;
      }
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>("input, select, textarea")?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !submitting) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button quiet" type="button" aria-label="关闭" onClick={onClose} disabled={submitting}>
            <X size={18} />
          </button>
        </header>
        <form onSubmit={onSubmit} noValidate>
          <div className="dialog-body">
            {error ? (
              <div className={`inline-alert ${isConflict(error) ? "conflict" : ""}`} role="alert">
                <AlertTriangle size={17} />
                <span>{isConflict(error) ? `${conflictLabel(error)}：${error.message}` : error.message}</span>
              </div>
            ) : null}
            {children}
          </div>
          <footer className="dialog-footer">
            <button className="button secondary" type="button" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : null}
              {submitting ? "正在提交" : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function isConflict(error: Error): boolean {
  return "isConflict" in error && error.isConflict === true;
}

function conflictLabel(error: Error): string {
  return "status" in error && (error.status === 412 || error.status === 428) ? "数据版本冲突" : "操作冲突";
}

export function Field({
  label,
  error,
  required,
  span = 1,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  span?: 1 | 2;
  children: ReactElement<{
    id?: string;
    required?: boolean;
    "aria-invalid"?: boolean;
    "aria-describedby"?: string;
  }>;
}) {
  const generatedControlId = useId();
  const errorId = useId();
  const controlId = children.props.id || generatedControlId;
  const describedBy =
    [children.props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(children, {
    id: controlId,
    required: required || children.props.required,
    "aria-invalid": Boolean(error) || children.props["aria-invalid"] || undefined,
    "aria-describedby": describedBy,
  });

  return (
    <div className={`field span-${span}`}>
      <label htmlFor={controlId}>
        {label}
        {required ? <b aria-hidden="true">*</b> : null}
      </label>
      {control}
      {error ? (
        <small id={errorId} className="field-error">
          {error}
        </small>
      ) : null}
    </div>
  );
}

function commandTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "accepted" || status === "pending") return "warning";
  return "info";
}

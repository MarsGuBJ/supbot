export function formatMoney(value: string | number | undefined): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(number);
}

export function formatCompactMoney(value: string | number | undefined): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

export function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function leaseTypeLabel(value: string): string {
  return value === "sale_and_leaseback" ? "售后回租" : value === "direct" ? "直接租赁" : value;
}

export function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    draft: "草稿",
    submitted: "已提交",
    approved: "已通过",
    rejected: "已拒绝",
    pending: "待处理",
    active: "生效中",
    completed: "已完成",
    pending_collection: "待收取",
    partially_collected: "部分实收",
    collected_pending_accounting: "待会计对账",
    reconciled: "已对账",
  };
  return labels[value] || value || "未知";
}

export function statusTone(value: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (["approved", "active", "completed"].includes(value)) {
    return "success";
  }
  if (["rejected", "overdue", "failed"].includes(value)) {
    return "danger";
  }
  if (
    [
      "submitted",
      "pending",
      "reviewing",
      "pending_collection",
      "partially_collected",
      "collected_pending_accounting",
    ].includes(value)
  ) {
    return "warning";
  }
  if (["draft"].includes(value)) {
    return "info";
  }
  return "neutral";
}

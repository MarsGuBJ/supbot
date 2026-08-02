import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Building2, Plus, Search } from "lucide-react";
import { createCustomer, fetchCustomers, newIdempotencyKey } from "../api";
import {
  CommandNotice,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
} from "../components/Workspace";
import { useRemoteData } from "../hooks/useRemoteData";
import type { CommandReceipt, CustomerCreateInput, Session } from "../types";
import { formatDateTime } from "../utils";

const EMPTY_FORM: CustomerCreateInput = {
  name: "",
  unifiedSocialCreditCode: "",
  industry: "",
  contactName: "",
  contactPhone: "",
};

export default function CustomersPage({ session }: { session: Session }) {
  const loader = useCallback((signal: AbortSignal) => fetchCustomers(session, signal), [session]);
  const { data, error, loading, reload } = useRemoteData(loader);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);

  const customers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return data?.items || [];
    }
    return (data?.items || []).filter((item) =>
      [item.name, item.unifiedSocialCreditCode, item.industry, item.contactName].some((value) =>
        value?.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [data, query]);

  const openDialog = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setSubmitError(null);
    setDialogOpen(true);
  };

  const closeDialog = useCallback(() => {
    if (!submitting) setDialogOpen(false);
  }, [submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateCustomer(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const nextReceipt = await createCustomer(session, trimCustomer(form), newIdempotencyKey("customer"));
      setReceipt(nextReceipt);
      setDialogOpen(false);
      reload();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("客户创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="客户主档"
        title="客户管理"
        meta={data ? `${data.total} 户客户` : undefined}
        action={
          <button className="button primary" type="button" onClick={openDialog}>
            <Plus size={17} />
            新增客户
          </button>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <div className="table-toolbar">
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">搜索客户</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="名称、统一社会信用代码、行业"
          />
        </label>
        <span>{customers.length} 条结果</span>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && customers.length === 0 ? (
        <EmptyState
          title={query ? "未找到匹配客户" : "暂无客户"}
          detail={query ? "请调整检索条件" : "创建首个客户主档后，才能发起租赁项目"}
        />
      ) : null}
      {!loading && !error && customers.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">客户主档列表</caption>
            <thead>
              <tr>
                <th>客户名称</th>
                <th>统一社会信用代码</th>
                <th>行业</th>
                <th>联系人</th>
                <th>更新时间</th>
                <th>版本</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <span className="primary-cell">
                      <Building2 size={16} />
                      {customer.name}
                    </span>
                    <small>{customer.id}</small>
                  </td>
                  <td className="mono">{customer.unifiedSocialCreditCode}</td>
                  <td>{customer.industry || "--"}</td>
                  <td>
                    {customer.contactName || "--"}
                    <small>{customer.contactPhone || ""}</small>
                  </td>
                  <td>{formatDateTime(customer.updatedAt)}</td>
                  <td className="mono">v{customer.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="新增客户"
        subtitle="建立承租人客户主档"
        submitting={submitting}
        submitLabel="提交创建"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="客户名称" required span={2} error={errors.name}>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              aria-invalid={Boolean(errors.name)}
            />
          </Field>
          <Field label="统一社会信用代码" required span={2} error={errors.unifiedSocialCreditCode}>
            <input
              className="mono"
              maxLength={18}
              value={form.unifiedSocialCreditCode}
              onChange={(event) => setForm({ ...form, unifiedSocialCreditCode: event.target.value.toUpperCase() })}
              aria-invalid={Boolean(errors.unifiedSocialCreditCode)}
            />
          </Field>
          <Field label="所属行业" required error={errors.industry}>
            <input
              value={form.industry}
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
              aria-invalid={Boolean(errors.industry)}
            />
          </Field>
          <Field label="联系人" required error={errors.contactName}>
            <input
              value={form.contactName}
              onChange={(event) => setForm({ ...form, contactName: event.target.value })}
              aria-invalid={Boolean(errors.contactName)}
            />
          </Field>
          <Field label="联系电话" required span={2} error={errors.contactPhone}>
            <input
              inputMode="tel"
              value={form.contactPhone}
              onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
              aria-invalid={Boolean(errors.contactPhone)}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function validateCustomer(form: CustomerCreateInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.name.trim().length < 2 || form.name.trim().length > 200) errors.name = "客户名称须为2至200个字符";
  if (!/^[0-9A-Z]{18}$/.test(form.unifiedSocialCreditCode.trim().toUpperCase()))
    errors.unifiedSocialCreditCode = "请输入18位统一社会信用代码";
  if (!form.industry.trim()) errors.industry = "请输入所属行业";
  if (!form.contactName.trim()) errors.contactName = "请输入联系人";
  if (!/^[0-9+()\-\s]{6,24}$/.test(form.contactPhone.trim())) errors.contactPhone = "请输入有效联系电话";
  return errors;
}

function trimCustomer(form: CustomerCreateInput): CustomerCreateInput {
  return {
    name: form.name.trim(),
    unifiedSocialCreditCode: form.unifiedSocialCreditCode.trim().toUpperCase(),
    industry: form.industry.trim(),
    contactName: form.contactName.trim(),
    contactPhone: form.contactPhone.trim(),
  };
}

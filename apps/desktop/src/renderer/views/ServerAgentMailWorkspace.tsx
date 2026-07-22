import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircleOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, MailOutlined, PaperClipOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined, SendOutlined, StarFilled, StarOutlined, SyncOutlined } from "@ant-design/icons";
import { Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Tabs, Tag, Tooltip, Typography, Upload, message } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { IdentityContext, ServstationMailAccount, ServstationMailAccountDraft, ServstationMailSecurityMode, ServstationMessageAccountRef, ServstationMessageAttachmentContent, ServstationMessageAttachmentUpload, ServstationMessageDetail, ServstationMessageFolder, ServstationMessageListItem } from "@supbot/shared";
import { formatMessageTime } from "../lib/servstationFormat";
import type { Translator } from "../lib/types";

export type ServerAgentMailTab = "messages" | "accounts";

export type ServerAgentMailComposeValues = {
  recipients?: string;
  externalRecipients?: string;
  senderMailAccountId?: string;
  subject?: string;
  body?: string;
  attachments?: UploadFile[];
};

export type ServerAgentMailAccountValues = {
  emailAddress?: string;
  displayName?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: ServstationMailSecurityMode;
  smtpUsername?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: ServstationMailSecurityMode;
  imapUsername?: string;
  imapPassword?: string;
  isDefault?: boolean;
  enabled?: boolean;
};

export function ServerAgentMailWorkspace({
  connected,
  disabled,
  identity,
  t
}: {
  connected: boolean;
  disabled: boolean;
  identity?: IdentityContext;
  t: Translator;
}) {
  const [tab, setTab] = useState<ServerAgentMailTab>("messages");
  const [folder, setFolder] = useState<ServstationMessageFolder>("inbox");
  const [items, setItems] = useState<ServstationMessageListItem[]>([]);
  const [selected, setSelected] = useState<ServstationMessageDetail | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [accounts, setAccounts] = useState<ServstationMailAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ServstationMailAccount | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [composeForm] = Form.useForm<ServerAgentMailComposeValues>();
  const [accountForm] = Form.useForm<ServerAgentMailAccountValues>();

  const outboundOptions = useMemo(
    () => accounts
      .filter((account) => account.enabled)
      .map((account) => ({
        value: account.id,
        label: account.isDefault ? `${account.emailAddress} (${t("Default")})` : account.emailAddress
      })),
    [accounts, t]
  );

  const refreshMessages = useCallback(async (nextFolder: ServstationMessageFolder = folder) => {
    if (!connected) {
      setItems([]);
      setSelected(null);
      setUnreadCount(0);
      return;
    }
    setLoadingMessages(true);
    try {
      const [messageResp, unreadResp] = await Promise.all([
        window.supbot.listServstationMessages(nextFolder),
        window.supbot.getServstationUnreadMessages()
      ]);
      setItems(messageResp.messages || []);
      setUnreadCount(unreadResp.unreadCount || 0);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoadingMessages(false);
    }
  }, [connected, folder, messageApi]);

  const refreshAccounts = useCallback(async () => {
    if (!connected) {
      setAccounts([]);
      return;
    }
    setAccountsLoading(true);
    try {
      setAccounts(await window.supbot.listServstationMailAccounts());
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setAccountsLoading(false);
    }
  }, [connected, messageApi]);

  useEffect(() => {
    void refreshMessages(folder);
  }, [folder, refreshMessages]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    const unsubscribe = window.supbot.onServstationMessageEvent((event) => {
      if (event.type === "messages.unread") {
        setUnreadCount(event.data.unreadCount || 0);
        if (folder === "inbox") {
          void refreshMessages("inbox");
        }
      }
    });
    const timer = window.setInterval(() => {
      void window.supbot.getServstationUnreadMessages()
        .then((summary) => setUnreadCount(summary.unreadCount || 0))
        .catch(() => undefined);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [connected, folder, refreshMessages]);

  const openMessage = async (messageId: string) => {
    if (disabled) {
      return;
    }
    try {
      const detail = await window.supbot.markServstationMessageRead(messageId);
      setSelected(detail);
      await refreshMessages(folder);
    } catch {
      try {
        setSelected(await window.supbot.getServstationMessage(messageId));
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    }
  };

  const openCompose = () => {
    const defaultAccount = accounts.find((account) => account.enabled && account.isDefault) || accounts.find((account) => account.enabled);
    composeForm.setFieldsValue({
      recipients: "",
      externalRecipients: "",
      senderMailAccountId: defaultAccount?.id,
      subject: "",
      body: "",
      attachments: []
    });
    setComposeOpen(true);
  };

  const submitCompose = async () => {
    if (!identity) {
      messageApi.error(t("Servstation identity is missing."));
      return;
    }
    try {
      const values = await composeForm.validateFields();
      const recipients = parseServstationMailRecipients(values.recipients || "", identity);
      const externalRecipients = parseExternalRecipients(values.externalRecipients || "");
      if (!recipients.length && !externalRecipients.length) {
        throw new Error(t("Enter at least one internal or external recipient."));
      }
      setSending(true);
      const files = ((values.attachments || []) as UploadFile[])
        .map((item) => item.originFileObj)
        .filter((file): file is NonNullable<UploadFile["originFileObj"]> => Boolean(file));
      const attachments = await Promise.all(files.map(fileToServstationMessageAttachment));
      if (externalRecipients.length) {
        await window.supbot.sendServstationDirectMessage({
          recipients,
          externalRecipients,
          senderMailAccountId: values.senderMailAccountId,
          subject: values.subject || "",
          body: values.body || "",
          attachments
        });
      } else {
        await window.supbot.sendServstationAgentMessage({
          recipients,
          subject: values.subject || "",
          body: values.body || "",
          attachments
        });
      }
      messageApi.success(t("Message queued."));
      setComposeOpen(false);
      composeForm.resetFields();
      await refreshMessages(folder);
    } catch (error) {
      const messageText = (error as Error).message;
      if (messageText) {
        messageApi.error(messageText);
      }
    } finally {
      setSending(false);
    }
  };

  const openAccountCreate = () => {
    setEditingAccount(null);
    accountForm.setFieldsValue({
      emailAddress: "",
      displayName: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecurity: "starttls",
      smtpUsername: "",
      smtpPassword: "",
      imapHost: "",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "",
      imapPassword: "",
      isDefault: accounts.length === 0,
      enabled: true
    });
    setAccountModalOpen(true);
  };

  const openAccountEdit = (account: ServstationMailAccount) => {
    setEditingAccount(account);
    accountForm.setFieldsValue({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecurity: account.smtpSecurity,
      smtpUsername: account.smtpUsername,
      smtpPassword: "",
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecurity: account.imapSecurity,
      imapUsername: account.imapUsername,
      imapPassword: "",
      isDefault: account.isDefault,
      enabled: account.enabled
    });
    setAccountModalOpen(true);
  };

  const submitAccount = async () => {
    try {
      const values = await accountForm.validateFields();
      setSavingAccount(true);
      const draft = normalizeServstationMailAccountDraft(values);
      if (editingAccount) {
        await window.supbot.updateServstationMailAccount(editingAccount.id, draft);
      } else {
        await window.supbot.createServstationMailAccount(draft);
      }
      messageApi.success(editingAccount ? t("Mail account updated.") : t("Mail account created."));
      setAccountModalOpen(false);
      setEditingAccount(null);
      accountForm.resetFields();
      await refreshAccounts();
    } catch (error) {
      const messageText = (error as Error).message;
      if (messageText) {
        messageApi.error(messageText);
      }
    } finally {
      setSavingAccount(false);
    }
  };

  const renderMessages = () => (
    <div className="server-agent-mail-grid">
      <section className="server-agent-mail-list-panel">
        <div className="server-agent-mail-panel-head">
          <Segmented
            value={folder}
            disabled={disabled}
            onChange={(value) => setFolder(value as ServstationMessageFolder)}
            options={[
              { label: t("Inbox"), value: "inbox" },
              { label: t("Trash"), value: "trash" }
            ]}
          />
          <Button icon={<ReloadOutlined />} loading={loadingMessages} disabled={disabled} onClick={() => void refreshMessages()} />
        </div>
        <div className="server-agent-mail-list">
          {items.length ? items.map((item) => (
            <button
              key={item.messageId}
              type="button"
              className={`server-agent-mail-list-item${item.messageId === selected?.messageId ? " is-selected" : ""}${item.readAt ? "" : " is-unread"}`}
              disabled={disabled}
              onClick={() => void openMessage(item.messageId)}
            >
              <span className="server-agent-mail-list-line">
                <strong>{item.subject || t("No subject")}</strong>
                <span>{formatMessageTime(item.createdAt)}</span>
              </span>
              <span className="server-agent-mail-list-line">
                <span>{formatServstationAccountRef(item.sender)}</span>
                <Space size={4}>
                  {item.channel ? <Tag>{t(item.channel === "email" ? "Email" : "Internal")}</Tag> : null}
                  {item.attachmentCount ? <Tag>{item.attachmentCount}</Tag> : null}
                </Space>
              </span>
              <span className="server-agent-mail-preview">{item.preview}</span>
            </button>
          )) : (
            <div className="server-agent-mail-empty">{connected ? t("No messages") : t("Servstation reverse A2A is not connected.")}</div>
          )}
        </div>
      </section>
      <section className="server-agent-mail-detail-panel">
        {selected ? (
          <>
            <div className="server-agent-mail-detail-head">
              <div>
                <Typography.Title level={4}>{selected.subject || t("No subject")}</Typography.Title>
                <div className="muted">{formatMessageTime(selected.createdAt)}</div>
              </div>
              <Space wrap>
                <Tooltip title={selected.favorited ? t("Unfavorite") : t("Favorite")}>
                  <Button
                    disabled={disabled}
                    icon={selected.favorited ? <StarFilled /> : <StarOutlined />}
                    onClick={() => void window.supbot.setServstationMessageFavorite(selected.messageId, !selected.favorited)
                      .then((messageDetail) => {
                        setSelected(messageDetail);
                        return refreshMessages(folder);
                      })
                      .catch((error: Error) => messageApi.error(error.message))}
                  />
                </Tooltip>
                {folder === "trash" ? (
                  <>
                    <Button
                      disabled={disabled}
                      icon={<RollbackOutlined />}
                      onClick={() => void window.supbot.restoreServstationMessage(selected.messageId)
                        .then(() => {
                          setSelected(null);
                          return refreshMessages("trash");
                        })
                        .catch((error: Error) => messageApi.error(error.message))}
                    >
                      {t("Restore")}
                    </Button>
                    <Popconfirm
                      title={t("Delete this message forever?")}
                      onConfirm={() => void window.supbot.deleteServstationMessage(selected.messageId)
                        .then(() => {
                          setSelected(null);
                          return refreshMessages("trash");
                        })
                        .catch((error: Error) => messageApi.error(error.message))}
                    >
                      <Button disabled={disabled} danger icon={<DeleteOutlined />}>{t("Delete forever")}</Button>
                    </Popconfirm>
                  </>
                ) : (
                  <Button
                    disabled={disabled}
                    icon={<DeleteOutlined />}
                    onClick={() => void window.supbot.trashServstationMessage(selected.messageId)
                      .then(() => {
                        setSelected(null);
                        return refreshMessages("inbox");
                      })
                      .catch((error: Error) => messageApi.error(error.message))}
                  >
                    {t("Move to trash")}
                  </Button>
                )}
              </Space>
            </div>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label={t("From")}>{formatServstationAccountRef(selected.sender)}</Descriptions.Item>
              <Descriptions.Item label={t("To")}>{(selected.recipients || []).map(formatServstationAccountRef).join(", ") || "-"}</Descriptions.Item>
            </Descriptions>
            <pre className="server-agent-mail-body">{selected.body}</pre>
            <div className="server-agent-mail-attachments">
              {(selected.attachments || []).map((attachment) => (
                <Button
                  key={attachment.attachmentId}
                  icon={<DownloadOutlined />}
                  disabled={disabled}
                  onClick={() => void window.supbot.fetchServstationMessageAttachment(selected.messageId, attachment.attachmentId)
                    .then(downloadServstationMessageAttachment)
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {attachment.fileName}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <div className="server-agent-mail-empty">{t("No messages")}</div>
        )}
      </section>
    </div>
  );

  const renderAccounts = () => (
    <section className="server-agent-mail-account-panel">
      <div className="server-agent-mail-panel-head">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={openAccountCreate}>{t("Add mail account")}</Button>
          <Button icon={<ReloadOutlined />} loading={accountsLoading} disabled={disabled} onClick={() => void refreshAccounts()}>{t("Refresh")}</Button>
        </Space>
      </div>
      {accounts.length ? (
        <div className="server-agent-mail-account-grid">
          {accounts.map((account) => (
            <article key={account.id} className="server-agent-mail-account-card">
              <div className="server-agent-mail-account-title">
                <div>
                  <strong>{account.emailAddress}</strong>
                  <span>{account.displayName || account.userId}</span>
                </div>
                <Space>
                  {account.isDefault ? <Tag color="cyan">{t("Default")}</Tag> : null}
                  <Tag color={account.enabled ? "green" : "default"}>{account.enabled ? t("Enabled") : t("Off")}</Tag>
                </Space>
              </div>
              <div className="server-agent-mail-account-meta">
                <span>SMTP {account.smtpHost}:{account.smtpPort}</span>
                <span>IMAP {account.imapHost}:{account.imapPort}</span>
                <span>{t("Last sync")}: {formatMessageTime(account.lastSyncAt)}</span>
                {account.lastSyncError ? <Alert type="warning" showIcon message={account.lastSyncError} /> : null}
              </div>
              <Space wrap>
                <Button icon={<EditOutlined />} disabled={disabled} onClick={() => openAccountEdit(account)}>{t("Edit")}</Button>
                <Button
                  icon={<CheckCircleOutlined />}
                  disabled={disabled || account.isDefault}
                  onClick={() => void window.supbot.setDefaultServstationMailAccount(account.id)
                    .then(() => {
                      messageApi.success(t("Default mail account updated."));
                      return refreshAccounts();
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Set default")}
                </Button>
                <Button
                  icon={<SyncOutlined />}
                  disabled={disabled}
                  onClick={() => void window.supbot.syncServstationMailAccountNow(account.id)
                    .then(() => messageApi.success(t("Mail sync started.")))
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Sync now")}
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() => void window.supbot.testServstationMailAccountConnection(account.id)
                    .then((result) => {
                      const ok = result.imapOk && result.smtpOk;
                      messageApi[ok ? "success" : "warning"](ok ? t("Connection test passed.") : t("Connection test failed."));
                      Modal.info({
                        title: t("Test connection"),
                        content: (
                          <div className="server-agent-mail-test-result">
                            <div>SMTP: {String(result.smtpOk)}, IMAP: {String(result.imapOk)}</div>
                            {result.smtpError ? <div>SMTP: {result.smtpError}</div> : null}
                            {result.imapError ? <div>IMAP: {result.imapError}</div> : null}
                          </div>
                        )
                      });
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Test connection")}
                </Button>
                <Popconfirm
                  title={t("Delete this mail account?")}
                  onConfirm={() => void window.supbot.deleteServstationMailAccount(account.id)
                    .then(() => {
                      messageApi.success(t("Mail account deleted."));
                      return refreshAccounts();
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  <Button danger icon={<DeleteOutlined />} disabled={disabled}>{t("Delete")}</Button>
                </Popconfirm>
              </Space>
            </article>
          ))}
        </div>
      ) : (
        <div className="server-agent-mail-empty">{connected ? t("No mail accounts") : t("Servstation reverse A2A is not connected.")}</div>
      )}
    </section>
  );

  return (
    <section className="server-agent-mail-workspace">
      {contextHolder}
      <div className="server-agent-mail-toolbar">
        <div>
          <Typography.Title level={3}>{t("Messages/Mail")}</Typography.Title>
          <div className="muted">{identity ? `${identity.userId} / ${identity.organizationId}/${identity.departmentId}` : t("Servstation identity is missing.")}</div>
        </div>
        <Space wrap>
          <Tag color="cyan">{t("Unread")}: {unreadCount}</Tag>
          <Button type="primary" icon={<SendOutlined />} disabled={disabled || !identity} onClick={openCompose}>{t("Send")}</Button>
        </Space>
      </div>
      <Tabs
        activeKey={tab}
        onChange={(value) => setTab(value as ServerAgentMailTab)}
        items={[
          { key: "messages", label: <span><MailOutlined /> {t("Inbox")}</span>, children: renderMessages() },
          { key: "accounts", label: <span><SyncOutlined /> {t("Mail accounts")}</span>, children: renderAccounts() }
        ]}
      />
      <Modal
        open={composeOpen}
        title={t("Send message")}
        onCancel={() => setComposeOpen(false)}
        width={760}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={() => setComposeOpen(false)}>{t("Cancel")}</Button>,
          <Button key="submit" type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void submitCompose()}>{t("Send")}</Button>
        ]}
      >
        <Form form={composeForm} layout="vertical">
          <Form.Item label={t("Internal recipients")} name="recipients">
            <Input placeholder="user-a, tenant/org/dept/user-b" disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("External email recipients")} name="externalRecipients">
            <Input placeholder="person@example.com, team@example.com" disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Send as")} name="senderMailAccountId">
            <Select allowClear placeholder={t("No outbound mail account selected")} options={outboundOptions} disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Subject")} name="subject" rules={[{ required: true, message: t("Subject") }]}>
            <Input disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Body")} name="body" rules={[{ required: true, message: t("Body") }]}>
            <Input.TextArea rows={8} disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Attached files")} name="attachments" valuePropName="fileList" getValueFromEvent={(event) => event?.fileList || []}>
            <Upload beforeUpload={() => false} multiple disabled={disabled || sending}>
              <Button icon={<PaperClipOutlined />} disabled={disabled || sending}>{t("Attach files")}</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={accountModalOpen}
        title={editingAccount ? t("Edit mail account") : t("Add mail account")}
        onCancel={() => setAccountModalOpen(false)}
        width={820}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={() => setAccountModalOpen(false)}>{t("Cancel")}</Button>,
          <Button key="submit" type="primary" loading={savingAccount} onClick={() => void submitAccount()}>{t("Save")}</Button>
        ]}
      >
        <Form form={accountForm} layout="vertical" className="server-agent-mail-account-form">
          <Form.Item label={t("Email address")} name="emailAddress" rules={[{ required: true, type: "email", message: t("Email address") }]}>
            <Input autoComplete="email" disabled={disabled || savingAccount} />
          </Form.Item>
          <Form.Item label={t("Display name")} name="displayName">
            <Input disabled={disabled || savingAccount} />
          </Form.Item>
          <div className="server-agent-mail-form-grid">
            <Form.Item label={t("SMTP host")} name="smtpHost" rules={[{ required: true, message: t("SMTP host") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP port")} name="smtpPort" rules={[{ required: true, message: t("SMTP port") }]}>
              <InputNumber min={1} max={65535} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP security")} name="smtpSecurity" rules={[{ required: true, message: t("SMTP security") }]}>
              <Select options={servstationMailSecurityOptions(t)} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP username")} name="smtpUsername" rules={[{ required: true, message: t("SMTP username") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP password")} name="smtpPassword" rules={[{ required: !editingAccount, message: t("SMTP password") }]}>
              <Input.Password autoComplete="new-password" disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP host")} name="imapHost" rules={[{ required: true, message: t("IMAP host") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP port")} name="imapPort" rules={[{ required: true, message: t("IMAP port") }]}>
              <InputNumber min={1} max={65535} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP security")} name="imapSecurity" rules={[{ required: true, message: t("IMAP security") }]}>
              <Select options={servstationMailSecurityOptions(t)} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP username")} name="imapUsername" rules={[{ required: true, message: t("IMAP username") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP password")} name="imapPassword" rules={[{ required: !editingAccount, message: t("IMAP password") }]}>
              <Input.Password autoComplete="new-password" disabled={disabled || savingAccount} />
            </Form.Item>
          </div>
          <Space size={24}>
            <Form.Item label={t("Default")} name="isDefault" valuePropName="checked">
              <Switch disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
              <Switch disabled={disabled || savingAccount} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </section>
  );
}

export function servstationMailSecurityOptions(t: Translator) {
  return [
    { value: "starttls", label: t("STARTTLS") },
    { value: "tls", label: t("TLS") },
    { value: "none", label: t("None") }
  ];
}

export function normalizeServstationMailAccountDraft(values: ServerAgentMailAccountValues): ServstationMailAccountDraft {
  const smtpPassword = values.smtpPassword?.trim();
  const imapPassword = values.imapPassword?.trim();
  return {
    emailAddress: values.emailAddress?.trim() || "",
    displayName: values.displayName?.trim() || "",
    smtpHost: values.smtpHost?.trim() || "",
    smtpPort: values.smtpPort || 587,
    smtpSecurity: values.smtpSecurity || "starttls",
    smtpUsername: values.smtpUsername?.trim() || "",
    ...(smtpPassword ? { smtpPassword } : {}),
    imapHost: values.imapHost?.trim() || "",
    imapPort: values.imapPort || 993,
    imapSecurity: values.imapSecurity || "tls",
    imapUsername: values.imapUsername?.trim() || "",
    ...(imapPassword ? { imapPassword } : {}),
    isDefault: values.isDefault === true,
    enabled: values.enabled !== false
  };
}

export function parseServstationMailRecipients(raw: string, identity: IdentityContext): ServstationMessageAccountRef[] {
  return raw
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split("/").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 4) {
        return { tenantId: parts[0], organizationId: parts[1], departmentId: parts[2], userId: parts[3] };
      }
      return {
        tenantId: identity.tenantId,
        organizationId: identity.organizationId,
        departmentId: identity.departmentId,
        userId: item
      };
    });
}

export function parseExternalRecipients(raw: string): string[] {
  return raw
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fileToServstationMessageAttachment(file: Blob & { name: string; type?: string }): Promise<ServstationMessageAttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve({
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        contentBase64: result.includes(",") ? result.split(",")[1] : result
      });
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function downloadServstationMessageAttachment(attachment: ServstationMessageAttachmentContent): void {
  const bytes = Uint8Array.from(atob(attachment.contentBase64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: attachment.contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function formatServstationAccountRef(ref: ServstationMessageAccountRef): string {
  return `${ref.userId} (${ref.organizationId}/${ref.departmentId})`;
}

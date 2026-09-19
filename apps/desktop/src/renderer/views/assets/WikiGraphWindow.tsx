import { useCallback, useState } from "react";
import { ConfigProvider, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { loadLanguage, translate, type Language } from "../../i18n";
import { WikiGraphPanel } from "./WikiGraphPanel";

/**
 * Standalone knowledge-graph window (?window=wikigraph&project=<name>).
 * Rendered by main.tsx instead of the full App when the query flag is present.
 */
export function WikiGraphWindow() {
  const [language] = useState<Language>(() => loadLanguage());
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
  const [messageApi, contextHolder] = message.useMessage();
  const project = new URLSearchParams(window.location.search).get("project") || "";

  return (
    <ConfigProvider locale={language === "zh" ? zhCN : enUS}>
      {contextHolder}
      <div className="assets-wikigraph-window">
        <WikiGraphPanel project={project} t={t} messageApi={messageApi} />
      </div>
    </ConfigProvider>
  );
}

import { useEffect, useRef, useState } from "react";
import { SearchOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Empty, Input, List, Spin, Tag } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { KbChatCitation, KbChatHistoryMessage, KbSearchResult } from "@supbot/shared";
import { kbHitTarget } from "../../lib/assetsFormat";
import type { Translator } from "../../lib/types";
import { MarkdownPreview } from "./MarkdownPreview";

type ChatEntry = { role: "user" | "assistant"; content: string; citations?: KbChatCitation[] };

export function WikiPanel({ project, t, messageApi }: { project: string; t: Translator; messageApi: MessageInstance }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<KbSearchResult[]>([]);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewBody, setPreviewBody] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHits([]);
    setPreviewTitle("");
    setPreviewBody("");
    setChatLog([]);
    setSearchQuery("");
    setChatInput("");
  }, [project]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatLog, chatLoading]);

  if (!project) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />;
  }

  const openHit = async (page: string, title?: string) => {
    const target = kbHitTarget(page);
    if (!target) {
      messageApi.warning(t("This hit cannot be previewed."));
      return;
    }
    setPreviewLoading(true);
    try {
      if (target.kind === "wiki") {
        const wikiPage = await window.supbot.kbReadWikiPage(project, target.rel);
        setPreviewTitle(title || wikiPage.meta.title || target.rel);
        setPreviewBody(wikiPage.body);
      } else {
        const markdown = await window.supbot.kbReadMarkdown(project, target.rel);
        setPreviewTitle(title || markdown.name);
        setPreviewBody(markdown.markdown);
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const search = async () => {
    const query = searchQuery.trim();
    if (!query || searching) {
      return;
    }
    setSearching(true);
    try {
      setHits(await window.supbot.kbSearch(project, query));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const ask = async () => {
    const query = chatInput.trim();
    if (!query || chatLoading) {
      return;
    }
    const history: KbChatHistoryMessage[] = chatLog.map((entry) => ({ role: entry.role, content: entry.content }));
    setChatLog((current) => [...current, { role: "user", content: query }]);
    setChatInput("");
    setChatLoading(true);
    try {
      const response = await window.supbot.kbChat(project, query, history);
      setChatLog((current) => [
        ...current,
        { role: "assistant", content: response.answer, citations: response.citations },
      ]);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="assets-wiki">
      <div className="assets-search-bar">
        <Input
          placeholder={t("Search wiki pages…")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onPressEnter={() => void search()}
          allowClear
        />
        <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={() => void search()}>
          {t("Search")}
        </Button>
      </div>
      <div className="assets-wiki-body">
        <div className="assets-wiki-hits">
          {hits.length ? (
            <List
              className="assets-list"
              dataSource={hits}
              renderItem={(hit) => (
                <List.Item className="assets-list-item assets-hit" onClick={() => void openHit(hit.page, hit.title)}>
                  <div className="assets-hit-title">
                    <span className="assets-list-text">{hit.title || hit.page}</span>
                    <Tag>{hit.score.toFixed(2)}</Tag>
                  </div>
                  {hit.snippet ? <div className="assets-hit-snippet">{hit.snippet}</div> : null}
                </List.Item>
              )}
            />
          ) : (
            <p className="assets-placeholder">{t("No search results")}</p>
          )}
        </div>
        <div className="assets-tab-preview assets-wiki-preview">
          <Spin spinning={previewLoading}>
            {previewBody ? (
              <>
                <div className="assets-preview-title">{previewTitle}</div>
                <MarkdownPreview text={previewBody} copyLabel={t("Copy")} />
              </>
            ) : (
              <p className="assets-placeholder">{t("Search or ask, then click a hit to preview the page")}</p>
            )}
          </Spin>
        </div>
      </div>
      <div className="assets-chat">
        <div className="assets-chat-log">
          {chatLog.length || chatLoading ? (
            <>
              {chatLog.map((entry, index) =>
                entry.role === "user" ? (
                  <div className="assets-chat-row user" key={index}>
                    <div className="assets-chat-bubble user">{entry.content}</div>
                  </div>
                ) : (
                  <div className="assets-chat-row" key={index}>
                    <div className="assets-chat-bubble">
                      <MarkdownPreview text={entry.content} />
                      {entry.citations?.length ? (
                        <div className="assets-citations">
                          <span className="assets-citations-label">{t("Citations")}</span>
                          {entry.citations.map((citation) => (
                            <button
                              type="button"
                              key={citation.ref}
                              className="assets-citation"
                              title={citation.page}
                              onClick={() => void openHit(citation.page, citation.title)}
                            >
                              [{citation.ref}] {citation.title || citation.page}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )}
              {chatLoading ? <div className="assets-chat-thinking">{t("Thinking…")}</div> : null}
              <div ref={chatEndRef} />
            </>
          ) : (
            <p className="assets-placeholder">{t("Ask questions based on this knowledge base")}</p>
          )}
        </div>
        <div className="assets-chat-input-row">
          <Input
            placeholder={t("Ask the knowledge base…")}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onPressEnter={() => void ask()}
            disabled={chatLoading}
          />
          <Button type="primary" icon={<SendOutlined />} loading={chatLoading} onClick={() => void ask()}>
            {t("Ask")}
          </Button>
        </div>
      </div>
    </div>
  );
}

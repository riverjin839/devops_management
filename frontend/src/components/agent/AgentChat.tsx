import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, Bot, Loader2, WifiOff, History, Plus, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { agentApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import { useClusterStore } from '@/stores/clusterStore';
import { useAuthStore } from '@/stores/authStore';
import { useAgentChatStore } from '@/stores/agentChatStore';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useFeatureAccess, canAccessFeature } from '@/hooks/useFeatureAccess';
import { CitationList } from '@/components/common/CitationList';
import { InfoRequestChips } from '@/components/agent/InfoRequestChips';
import type { AgentInfoRequest, RagCitation } from '@/types';
import { generateUUID } from '@/lib/utils';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: RagCitation[];
  requests?: AgentInfoRequest[];
  /** 스트리밍 중인 메시지 — 완료 전까지 커서/로딩 표시, 완료 후 마크다운 렌더 전환 */
  streaming?: boolean;
  timestamp: Date;
}

interface StreamDonePayload {
  done: true;
  status: 'ok' | 'offline' | 'error';
  model: string;
  conversation_id: string | null;
  citations: RagCitation[];
  requests: AgentInfoRequest[];
  error: string | null;
}

/**
 * ``/agent/chat/stream`` SSE 소비 — 인증 fetch 기반(EventSource 는 Authorization
 * 헤더를 못 보내므로 PodLogStream.tsx 와 동일한 fetch+reader 패턴을 쓴다).
 * 서버가 초기 응답조차 못 주면(네트워크 오류·비2xx) reject 하여 호출부가
 * 비스트리밍 ``/agent/chat`` 으로 폴백할 수 있게 한다.
 */
async function streamChat(
  body: { query: string; context?: Record<string, unknown>; conversation_id: string | null },
  onDelta: (text: string) => void,
  onDone: (payload: StreamDonePayload) => void,
): Promise<void> {
  const token = getAuthToken();
  const resp = await fetch('/api/v1/agent/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`stream unavailable (HTTP ${resp.status})`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const ln of block.split('\n')) {
        if (!ln.startsWith('data:')) continue;
        const raw = ln.slice(5).replace(/^ /, '');
        let payload: { delta?: string } & Partial<StreamDonePayload>;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        if (payload.done) onDone(payload as StreamDonePayload);
        else if (typeof payload.delta === 'string') onDelta(payload.delta);
      }
    }
  }
}

// feature_access 게이트 키 — 라우트는 아니지만 화면별 접근 제어 규칙과 동일한 키 체계.
// Sidebar.tsx 의 트리거 아이콘도 같은 키로 접근 가능 여부를 판정한다(아이콘 자체를 숨김).
export const AGENT_CHAT_FEATURE_KEY = '/agent-chat';
const FEATURE_KEY = AGENT_CHAT_FEATURE_KEY;

/**
 * 전역 AI 챗봇 — 한국어 우선, 멀티턴 대화 지속(서버 저장),
 * RAG 근거 인용(사내 문서 딥링크), AI 정보요청 칩(운영자 매개 — 자율 실행 없음).
 * 열림 트리거는 사이드바 하단 레일 아이콘(`Sidebar.tsx`)이 쥐고 있고, 이 컴포넌트는
 * `useAgentChatStore` 로 그 상태를 공유해 패널만 그린다.
 */
export function AgentChat() {
  const { open: isOpen, setOpen: setIsOpen } = useAgentChatStore();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null); // null = unknown
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [conversations, setConversations] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { clusters, addons } = useClusterStore();
  const user = useAuthStore((s) => s.user);
  const { data: featureAccess } = useFeatureAccess();

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const checkHealth = useCallback(async () => {
    try {
      const { data } = await agentApi.health();
      setIsOnline(data.status === 'online');
    } catch {
      setIsOnline(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      checkHealth();
    }
  }, [isOpen, checkHealth]);

  // 화면별 접근 제어 — 규칙에서 차단되면 FAB 자체를 렌더하지 않는다.
  if (!canAccessFeature(featureAccess, FEATURE_KEY, user)) {
    return null;
  }

  const buildContext = (): Record<string, unknown> | undefined => {
    if (clusters.length === 0) return undefined;
    const clusterSummaries = clusters.map((c) => `${c.name}: ${c.status}`).join(', ');
    const addonSummaries = Object.entries(addons)
      .flatMap(([, list]) => list.map((a) => `${a.name}(${a.status})`))
      .slice(0, 20)
      .join(', ');

    return {
      cluster_name: clusterSummaries,
      cluster_status: `${clusters.length}개 클러스터`,
      extra: addonSummaries ? `애드온: ${addonSummaries}` : undefined,
    };
  };

  const addMessage = (
    role: ChatMessage['role'],
    content: string,
    extra?: Pick<ChatMessage, 'citations' | 'requests'>,
  ) => {
    setMessages((prev) => [
      ...prev,
      { id: generateUUID(), role, content, timestamp: new Date(), ...extra },
    ]);
  };

  const sendQueryNonStreaming = async (query: string) => {
    const { data } = await agentApi.chat({
      query,
      context: buildContext(),
      conversationId,
    });
    if (data.conversationId) setConversationId(data.conversationId);
    if (data.status === 'offline') {
      setIsOnline(false);
      addMessage('system', data.answer);
    } else {
      setIsOnline(true);
      addMessage('assistant', data.answer, {
        citations: data.citations ?? [],
        requests: data.requests ?? [],
      });
    }
  };

  const sendQuery = async (query: string) => {
    if (!query || isLoading) return;
    addMessage('user', query);
    setIsLoading(true);

    const assistantId = generateUUID();
    let streamStarted = false;
    try {
      await streamChat(
        { query, context: buildContext(), conversation_id: conversationId },
        (delta) => {
          if (!streamStarted) {
            // 첫 델타가 도착해야 진짜 스트리밍이 시작된 것 — 그 전까지는 로딩 표시 유지.
            streamStarted = true;
            setIsLoading(false);
            setMessages((prev) => [
              ...prev,
              { id: assistantId, role: 'assistant', content: '', streaming: true, timestamp: new Date() },
            ]);
          }
          setMessages((prev) => prev.map((m) => (
            m.id === assistantId ? { ...m, content: m.content + delta } : m
          )));
        },
        (done) => {
          setIsOnline(done.status !== 'offline');
          if (done.conversation_id) setConversationId(done.conversation_id);
          if (streamStarted) {
            setMessages((prev) => prev.map((m) => (
              m.id === assistantId
                ? { ...m, streaming: false, citations: done.citations, requests: done.requests }
                : m
            )));
          } else {
            // 델타 없이 done 만 온 경우(전체 실패) — 오프라인 안내 메시지로 대체.
            addMessage('system', 'AI 서버가 응답하지 않습니다. Settings → AI/LLM 에서 연결 상태를 확인하세요.');
          }
        },
      );
    } catch {
      if (streamStarted) {
        // 이미 일부 응답을 받은 뒤 연결이 끊김 — 새로 재시도(중복 답변)하지 않고
        // 지금까지 받은 내용 그대로 마무리한다.
        setMessages((prev) => prev.map((m) => (
          m.id === assistantId ? { ...m, streaming: false } : m
        )));
        setIsOnline(false);
      } else {
        // 스트림 자체를 시작하지 못함(구버전 프록시/네트워크) — 비스트리밍 폴백.
        try {
          await sendQueryNonStreaming(query);
        } catch {
          setIsOnline(false);
          addMessage('system', 'AI 서버가 응답하지 않습니다. Settings → AI/LLM 에서 연결 상태를 확인하세요.');
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    const query = input.trim();
    if (!query) return;
    setInput('');
    await sendQuery(query);
  };

  const startNewConversation = () => {
    setConversationId(null);
    setMessages([]);
    setDrawerOpen(false);
  };

  const openDrawer = async () => {
    setDrawerOpen(true);
    try {
      const res = await agentApi.conversations();
      setConversations(res.data.data);
    } catch {
      setConversations([]);
    }
  };

  const loadConversation = async (id: string) => {
    try {
      const res = await agentApi.messages(id);
      setConversationId(id);
      setMessages(res.data.data.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations,
        requests: m.requests,
        timestamp: new Date(m.createdAt),
      })));
      setDrawerOpen(false);
    } catch {
      // 조회 실패 — 현재 대화 유지
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await agentApi.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) startNewConversation();
    } catch {
      // 삭제 실패 무시 (목록 새로고침으로 복구)
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Render ────────────────────────────────────────────────────────
  // 열기/닫기 트리거는 사이드바 하단 레일의 "AI 어시스턴트" 아이콘(Sidebar.tsx) — 여기서는
  // 패널만 그린다. 트리거가 좌측 사이드바에 고정돼 있으므로 패널도 그 근처(좌하단)에서 연다.

  return (
    <>
      {/* Chat Window */}
      {isOpen && (
        <div
          style={{ left: NAV_WIDTH + 12 }}
          className="fixed bottom-4 z-50 w-[420px] h-[560px] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-card">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              <span className="font-semibold text-sm">AI 어시스턴트</span>
              {isOnline === true && (
                <span className="w-2 h-2 rounded-full bg-status-healthy" title="온라인" />
              )}
              {isOnline === false && (
                <span className="flex items-center gap-1 text-sm text-status-warning">
                  <WifiOff className="w-3 h-3" /> 오프라인
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={startNewConversation}
                title="새 대화"
                aria-label="새 대화"
                className="p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => (drawerOpen ? setDrawerOpen(false) : void openDrawer())}
                title="대화 목록"
                aria-label="대화 목록"
                className="p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <History className="w-4 h-4" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                title="닫기"
                aria-label="닫기"
                className="p-1.5 rounded-xl text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 대화 목록 드로어 */}
          {drawerOpen && (
            <div className="border-b border-border max-h-48 overflow-y-auto bg-secondary/30">
              {conversations.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">저장된 대화가 없습니다.</p>
              ) : (
                conversations.map((c) => (
                  <div key={c.id} className="px-3 py-1.5 flex items-center gap-2 hover:bg-secondary/60">
                    <button
                      onClick={() => void loadConversation(c.id)}
                      className="flex-1 text-left text-xs truncate hover:text-primary"
                      title={c.title}
                    >
                      {c.title}
                    </button>
                    <button
                      onClick={() => void deleteConversation(c.id)}
                      title="대화 삭제"
                      aria-label={`대화 '${c.title}' 삭제`}
                      className="p-1 rounded text-muted-foreground hover:text-status-critical"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-sm py-12">
                <Bot className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>클러스터 운영에 대해 무엇이든 물어보세요.</p>
                <p className="text-sm mt-1 opacity-70">
                  예: &quot;파드가 CrashLoop 인 이유가 뭐야?&quot;
                </p>
                <p className="text-xs mt-2 opacity-60">
                  답변에는 사내 문서 근거가 인용되며, AI 는 분석·조언만 하고 아무것도 직접 실행하지 않습니다.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
                      : msg.role === 'system'
                        ? 'bg-status-warning/15 text-status-warning border border-status-warning/20 rounded-bl-sm whitespace-pre-wrap'
                        : 'bg-secondary text-foreground rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="space-y-2">
                      {msg.streaming ? (
                        // 스트리밍 중엔 마크다운 파서가 미완성 구문(닫히지 않은 ``` 등)을
                        // 잘못 렌더링할 수 있어 완료 전까지는 순수 텍스트로 표시한다.
                        <p className="whitespace-pre-wrap">
                          {msg.content}
                          <span className="inline-block w-1.5 h-3.5 ml-0.5 -mb-0.5 bg-current animate-pulse" aria-hidden />
                        </p>
                      ) : (
                        <div className="prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto [&_pre]:text-xs">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        </div>
                      )}
                      {msg.citations && msg.citations.length > 0 && (
                        <CitationList citations={msg.citations} />
                      )}
                      {msg.requests && msg.requests.length > 0 && (
                        <InfoRequestChips
                          requests={msg.requests}
                          onProvide={(text) => void sendQuery(text)}
                        />
                      )}
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-secondary text-muted-foreground px-3 py-2 rounded-xl rounded-bl-sm text-sm flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  생각 중…
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-border">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isOnline === false ? 'AI 오프라인 — Settings → AI/LLM 확인' : '클러스터에 대해 질문하세요…'}
                disabled={isLoading}
                className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 placeholder:text-muted-foreground"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                title="보내기"
                aria-label="질문 보내기"
                className="w-9 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

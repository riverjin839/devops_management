import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, Bot, Loader2, WifiOff } from 'lucide-react';
import { agentApi } from '@/services/api';
import { useClusterStore } from '@/stores/clusterStore';
import type { AgentChatResponse } from '@/types';
import { generateUUID } from '@/lib/utils';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export function AgentChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null); // null = unknown
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { clusters, addons } = useClusterStore();

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

  // Check Ollama health when chat opens
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

  const buildContext = (): Record<string, unknown> | undefined => {
    if (clusters.length === 0) return undefined;
    const clusterSummaries = clusters.map((c) => `${c.name}: ${c.status}`).join(', ');
    const addonSummaries = Object.entries(addons)
      .flatMap(([, list]) => list.map((a) => `${a.name}(${a.status})`))
      .slice(0, 20)
      .join(', ');

    return {
      cluster_name: clusterSummaries,
      cluster_status: `${clusters.length} cluster(s)`,
      extra: addonSummaries ? `Addons: ${addonSummaries}` : undefined,
    };
  };

  const addMessage = (role: ChatMessage['role'], content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: generateUUID(), role, content, timestamp: new Date() },
    ]);
  };

  const handleSend = async () => {
    const query = input.trim();
    if (!query || isLoading) return;

    setInput('');
    addMessage('user', query);
    setIsLoading(true);

    try {
      const { data } = await agentApi.chat({ query, context: buildContext() });
      const resp = data as unknown as AgentChatResponse;

      if (resp.status === 'offline') {
        setIsOnline(false);
        addMessage('system', resp.answer);
      } else {
        setIsOnline(true);
        addMessage('assistant', resp.answer);
      }
    } catch {
      // Network error / backend unreachable — dashboard keeps working
      setIsOnline(false);
      addMessage(
        'system',
        'AI Server is not responding. Please check the Ollama connection.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <>
      {/* FAB Button */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all flex items-center justify-center hover:scale-105 active:scale-95"
        aria-label="Toggle AI Agent"
      >
        {isOpen ? <X className="w-6 h-6" /> : <Bot className="w-6 h-6" />}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 z-50 w-[400px] h-[520px] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-card">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              <span className="font-semibold text-sm">AI Agent</span>
              {isOnline === true && (
                <span className="w-2 h-2 rounded-full bg-green-500" title="Online" />
              )}
              {isOnline === false && (
                <span className="flex items-center gap-1 text-sm text-orange-400">
                  <WifiOff className="w-3 h-3" /> Offline
                </span>
              )}
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-sm py-12">
                <Bot className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Ask me about your Kubernetes clusters.</p>
                <p className="text-sm mt-1 opacity-70">
                  e.g. &quot;Why is my pod CrashLooping?&quot;
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : msg.role === 'system'
                        ? 'bg-orange-500/15 text-orange-300 border border-orange-500/20 rounded-bl-sm'
                        : 'bg-secondary text-foreground rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-secondary text-muted-foreground px-3 py-2 rounded-xl rounded-bl-sm text-sm flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Thinking...
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
                placeholder={isOnline === false ? 'AI Agent offline...' : 'Ask about your clusters...'}
                disabled={isLoading}
                className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 placeholder:text-muted-foreground"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
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

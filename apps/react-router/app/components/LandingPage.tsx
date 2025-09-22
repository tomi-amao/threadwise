import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router';
import MarkdownRenderer from './MarkdownRenderer';
import { sendMessageToAgent, checkAgentHealth, resetConversation } from '../services/aiAgent';

interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: Date;
}

export default function LandingPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Check agent health on component mount
  useEffect(() => {
    const checkHealth = async () => {
      const isOnline = await checkAgentHealth();
      setAgentOnline(isOnline);
    };
    checkHealth();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputValue.trim(),
      role: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      // Send message to AI agent
      const response = await sendMessageToAgent(userMessage.content);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: response.error || response.content,
        role: 'assistant',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const adjustTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const handleSamplePrompt = (prompt: string) => {
    setInputValue(prompt);
    textareaRef.current?.focus();
  };

  const handleResetConversation = async () => {
    await resetConversation();
    setMessages([]);
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue]);

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 flex flex-col gradient-bg-primary">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 glass-effect sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">ThreadWise</h1>

          <div className="flex items-center gap-4">
            {/* Test Chat Link */}
            <Link
              to="/test-chat"
              className="px-3 py-1 text-xs bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              🧪 Test Chat UI
            </Link>

            {/* Reset Conversation Button */}
            {messages.length > 0 && (
              <button
                onClick={handleResetConversation}
                className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                New Chat
              </button>
            )}

            {/* Agent Status Indicator */}
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full status-indicator ${
                  agentOnline === null
                    ? 'bg-gray-400'
                    : agentOnline
                      ? 'bg-green-500 online'
                      : 'bg-red-500 offline'
                }`}
              ></div>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {agentOnline === null
                  ? 'Checking...'
                  : agentOnline
                    ? 'LangGraph Online'
                    : 'LangGraph Offline'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Chat Container */}
      <main className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto px-4 py-6 custom-scrollbar">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <div className="max-w-2xl mx-auto">
                <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                  Welcome to ThreadWise
                </h2>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Your AI-powered financial assistant. Ask questions, get insights, or explore
                  financial data with natural language.
                </p>

                {agentOnline === false && (
                  <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      💡 <strong>LangGraph server not detected.</strong> Make sure to run{' '}
                      <code className="bg-amber-100 dark:bg-amber-800 px-1 rounded">
                        poetry run langgraph dev
                      </code>{' '}
                      from the ai-agent directory to start the agent on port 8123.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                  <button
                    onClick={() =>
                      handleSamplePrompt(
                        'Explain the basics of financial portfolio diversification'
                      )
                    }
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors text-left"
                  >
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">
                      💡 Portfolio Advice
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Learn about diversification strategies
                    </p>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt('What are the current market trends in technology stocks?')
                    }
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors text-left"
                  >
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">
                      🔍 Market Analysis
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Get insights on market trends
                    </p>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt('Help me calculate the ROI for a potential investment')
                    }
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors text-left"
                  >
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">
                      ⚡ Quick Calculations
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Calculate investment returns
                    </p>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt(
                        'Explain the difference between stocks and bonds in simple terms'
                      )
                    }
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors text-left"
                  >
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">
                      📚 Learn Basics
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Understand financial fundamentals
                    </p>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map(message => (
                <div
                  key={message.id}
                  className={`flex animate-fade-in-up ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`flex max-w-[80%] message-bubble ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'} gap-3`}
                  >
                    {/* Avatar */}
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        message.role === 'user'
                          ? 'gradient-bg-message text-white'
                          : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                      }`}
                    >
                      {message.role === 'user' ? '👤' : '🤖'}
                    </div>

                    {/* Message Content */}
                    <div
                      className={`rounded-2xl px-4 py-3 ${
                        message.role === 'user'
                          ? 'gradient-bg-message text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                      }`}
                    >
                      {message.role === 'user' ? (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      ) : (
                        <MarkdownRenderer content={message.content} />
                      )}
                      <div
                        className={`text-xs mt-2 opacity-70 ${
                          message.role === 'user'
                            ? 'text-blue-100'
                            : 'text-gray-500 dark:text-gray-400'
                        }`}
                      >
                        {message.timestamp.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {/* Loading indicator */}
              {isLoading && (
                <div className="flex justify-start animate-slide-in-right">
                  <div className="flex gap-3 max-w-[80%] message-bubble">
                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                      🤖
                    </div>
                    <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-3">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-typing-dots"></div>
                        <div
                          className="w-2 h-2 bg-gray-400 rounded-full animate-typing-dots"
                          style={{ animationDelay: '0.2s' }}
                        ></div>
                        <div
                          className="w-2 h-2 bg-gray-400 rounded-full animate-typing-dots"
                          style={{ animationDelay: '0.4s' }}
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="border-t border-gray-200 dark:border-gray-800 glass-effect">
          <div className="max-w-4xl mx-auto px-4 py-4">
            <form onSubmit={handleSubmit} className="relative">
              <div className="flex items-end gap-3 bg-gray-100 dark:bg-gray-800 rounded-2xl p-3 gradient-border focus-within:animate-pulse-glow transition-all duration-300">
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message ThreadWise..."
                  className="flex-1 bg-transparent border-0 outline-none resize-none text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 min-h-[24px] max-h-[200px] focus-ring"
                  rows={1}
                />
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isLoading}
                  className="w-8 h-8 gradient-bg-message hover:scale-105 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white rounded-full flex items-center justify-center transition-all duration-300 flex-shrink-0 button-enhance focus-ring"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                    />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                Press Enter to send, Shift+Enter for new line
              </p>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

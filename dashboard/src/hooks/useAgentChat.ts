import { useState, useRef, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClarificationDetails {
  type?: string;
  choices?: Array<string | { label: string; value: string }>;
  [key: string]: unknown;
}

export interface Clarification {
  question: string;
  details: ClarificationDetails;
  originalRequest: string;
}

export interface LiveMetric {
  tool: string;
  args: unknown;
}

export const INITIAL_GREETING = 'Hello! I can analyze your local code-insights sessions to extract SFL-compliant insights. What would you like to know?';

export function useAgentChat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: INITIAL_GREETING }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [savedState, setSavedState] = useState<unknown>(null);
  const [clarification, setClarification] = useState<Clarification | null>(null);
  const [liveMetrics, setLiveMetrics] = useState<LiveMetric[]>([]);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const sendMessage = useCallback(async (textToSubmit?: string) => {
    const text = textToSubmit || input;
    if (!text.trim() && !clarification) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const userMessage = { role: 'user' as const, content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setLiveMetrics([]);

    try {
      // Filter out the initial greeting
      const history = messages
        .filter(m => m.content !== INITIAL_GREETING)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
      
      const payload = clarification 
        ? { answer: text, savedState, chatHistory: history, request: clarification.originalRequest } 
        : { request: text, chatHistory: history };

      if (clarification) {
        setClarification(null);
        setSavedState(null);
      }

      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const contentType = response.headers.get('content-type');
      
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        if (data.type === 'clarification') {
          setClarification({
            question: data.question,
            details: data.clarificationDetails,
            originalRequest: clarification ? clarification.originalRequest : text
          });
          setSavedState(data.savedState);
          setIsLoading(false);
          return;
        }
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      
      if (!reader) throw new Error('No reader available');
      
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; 
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const parsed = JSON.parse(line);
            
            if (parsed.type === 'chunk') {
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIndex = newMessages.length - 1;
                newMessages[lastIndex].content += parsed.text;
                return newMessages;
              });
            } else if (parsed.type === 'metric') {
              setLiveMetrics((prev) => [...prev, parsed]);
            }
          } catch (e) {
            console.error('Failed to parse NDJSON line:', line, e);
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Request aborted');
      } else {
        console.error('Failed to fetch:', error);
        toast.error('Agent connection failed', {
          description: 'An error occurred while communicating with the agent. Check the console and server logs.',
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [input, messages, clarification, savedState]);

  const clearMessages = useCallback(() => {
    setMessages([{ role: 'assistant', content: INITIAL_GREETING }]);
    setClarification(null);
    setLiveMetrics([]);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  return {
    input,
    setInput,
    messages,
    isLoading,
    clarification,
    liveMetrics,
    sendMessage,
    clearMessages
  };
}

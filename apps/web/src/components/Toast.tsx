import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: string;
  text: string;
}

let toastListeners: Array<(msg: ToastMessage) => void> = [];

export function showToast(text: string) {
  const msg: ToastMessage = { id: crypto.randomUUID(), text };
  toastListeners.forEach((fn) => fn(msg));
}

export function Toast() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (msg: ToastMessage) => {
      setMessages((prev) => [...prev, msg]);
      setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      }, 1500);
    };

    toastListeners.push(handler);
    return () => {
      toastListeners = toastListeners.filter((fn) => fn !== handler);
    };
  }, []);

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="animate-fade-in rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white shadow-lg"
        >
          {msg.text}
        </div>
      ))}
    </div>
  );
}

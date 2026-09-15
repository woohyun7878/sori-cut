import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { usePresetStore, type ConversationTurn } from '../store/usePresetStore';
import type { ToolActivityItem } from '../lib/activity';

const SUGGESTIONS = [
  'More gain and a tighter low end',
  'Give me more sustain without extra noise',
  'Brighten the amp and slow the delay down',
];

/**
 * Bender's request box.
 *
 * A plain-English request goes to the backend, which reasons and calls
 * constrained editing tools. That round trip takes several seconds, so the
 * input locks and an activity line shows while it works; when it returns, the
 * tool calls are shown after the fact as an honest, compact feed — never raw
 * JSON and never the model's private reasoning.
 */
export function RequestBox() {
  const conversation = usePresetStore((state) => state.conversation);
  const isSending = usePresetStore((state) => state.isSending);
  const sendMessage = usePresetStore((state) => state.sendMessage);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conversation, isSending]);

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;
    void sendMessage(trimmed);
    setInput('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
        {conversation.length === 0 ? (
          <div className="flex h-full flex-col justify-center gap-3 text-center">
            <p className="text-sm text-secondary">
              Tell Bender what you want to change, in your own words.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  disabled={isSending}
                  className="btn-secondary max-w-full"
                >
                  <span className="truncate">{suggestion}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          conversation.map((turn) => <Turn key={turn.id} turn={turn} />)
        )}

        {isSending ? <Working /> : null}
      </div>

      <form onSubmit={handleSubmit} className="mt-3 border-t border-editor-border pt-3">
        <label htmlFor="tone-request" className="sr-only">
          Describe a tone change
        </label>
        <textarea
          id="tone-request"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSending}
          rows={2}
          placeholder="e.g. more gain, tighter low end, a slower delay"
          className="w-full resize-none rounded-control border border-editor-border bg-surface-raised px-3 py-2 text-sm text-primary placeholder:text-muted disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">
            {isSending
              ? 'Bender is reasoning and editing — this can take 5–20 seconds.'
              : 'Enter to send · Shift+Enter for a new line'}
          </p>
          <button type="submit" disabled={isSending || input.trim() === ''} className="btn-primary">
            {isSending ? 'Working…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: ConversationTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-8 rounded-control border border-editor-border bg-hover/40 px-3 py-2">
        <p className="eyebrow mb-1 text-secondary">You</p>
        <p className="whitespace-pre-wrap text-sm text-primary">{turn.text}</p>
      </div>
    );
  }

  if (turn.role === 'error') {
    return (
      <div className="mr-8 rounded-control border border-danger/40 bg-danger/10 px-3 py-2">
        <p className="eyebrow mb-1 text-danger">Bender hit a problem</p>
        <p className="whitespace-pre-wrap text-sm text-danger">{turn.text}</p>
        {turn.hint ? <p className="mt-1 text-xs text-danger/80">{turn.hint}</p> : null}
      </div>
    );
  }

  return (
    <div className="mr-8 rounded-control border border-editor-border bg-surface-raised px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="led" aria-hidden="true" />
        <p className="eyebrow text-secondary">Bender</p>
        <span className="ml-auto text-[10px] text-muted">{(turn.latencyMs / 1000).toFixed(1)}s</span>
      </div>
      {turn.activity.length > 0 ? <ActivityFeed items={turn.activity} /> : null}
      <p className="whitespace-pre-wrap text-sm text-primary">{turn.text}</p>
      {turn.truncated ? (
        <p className="mt-1 text-xs text-warning">
          Bender ran out of steps before finishing — review the diff and ask it to continue.
        </p>
      ) : null}
      {turn.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {turn.warnings.map((warning, index) => (
            <li key={index} className="text-[11px] text-warning">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ActivityFeed({ items }: { items: ToolActivityItem[] }) {
  return (
    <ul className="mb-2 space-y-1 rounded-control bg-canvas/50 p-2">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-2 text-[11px] leading-5">
          <span
            aria-hidden="true"
            className={item.ok ? 'text-success' : 'text-danger'}
          >
            {item.ok ? '✓' : '✕'}
          </span>
          <span className={item.ok ? 'text-secondary' : 'text-danger'}>
            <span className="font-medium">{item.verb}</span>
            {item.detail ? <span className="text-muted"> — {item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Working() {
  return (
    <div className="mr-8 flex items-center gap-2 rounded-control border border-editor-border bg-surface-raised px-3 py-2">
      <span className="led animate-pulse" aria-hidden="true" />
      <p className="text-sm text-secondary">Bender is working…</p>
    </div>
  );
}

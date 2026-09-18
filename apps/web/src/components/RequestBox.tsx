import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { usePresetStore, type ConversationTurn } from '../store/usePresetStore';
import type { ToolActivityItem } from '../lib/activity';

const SUGGESTIONS = [
  'More gain and a tighter low end',
  'Give me more sustain without extra noise',
  'Brighten the amp and slow the delay down',
];

/**
 * Bender's request box — the conversation is the product surface.
 *
 * A plain-English request goes to the backend, which reasons and calls
 * constrained editing tools. That round trip takes several seconds, so the
 * input locks and a live step shows while it works; when it returns, the tool
 * calls are shown after the fact as an honest, compact feed — never raw JSON
 * and never the model's private reasoning.
 */
export function RequestBox() {
  const conversation = usePresetStore((state) => state.conversation);
  const isSending = usePresetStore((state) => state.isSending);
  const sendMessage = usePresetStore((state) => state.sendMessage);
  const presetLoaded = usePresetStore((state) => state.view !== null);
  const [input, setInput] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // `scrollTop` rather than `scrollTo`: it is the one that exists everywhere,
    // including jsdom, and the thread is short enough not to want smoothing.
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [conversation, isSending]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isSending || !presetLoaded) return;
    void sendMessage(trimmed);
    setInput('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input);
    }
  };

  const applySuggestion = (suggestion: string) => {
    setInput(suggestion);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col rounded-editor border border-editor-border bg-surface px-[22px] pb-[18px] pt-5 lg:min-h-[520px]">
      <div className="mb-[18px] flex items-center justify-between gap-4">
        <p className="eyebrow-lit">AI agent</p>
        <p className="eyebrow">Your request</p>
      </div>

      {conversation.length === 0 ? (
        <div>
          <h2 className="text-[25px] font-semibold text-primary">Describe a tone change</h2>
          <p className="mt-2.5 max-w-[54ch] text-sm leading-relaxed text-secondary">
            {presetLoaded
              ? 'Tell Bender what you want to change in your preset, in plain English. Every edit is shown before you download it.'
              : 'Load a preset or start from a tone, then tell Bender what you want to change in plain English.'}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => applySuggestion(suggestion)}
                disabled={isSending}
                className="btn-pill"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div
        ref={threadRef}
        aria-live="polite"
        aria-label="Conversation with Bender"
        className="my-[22px] flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto"
      >
        {conversation.map((turn, index) => (
          <Turn
            key={turn.id}
            turn={turn}
            lastRequest={lastRequestBefore(conversation, index)}
            onRetry={send}
            retryable={!isSending && index === conversation.length - 1}
          />
        ))}
        {isSending ? <Working /> : null}
      </div>

      <form onSubmit={handleSubmit}>
        <div className="rounded-editor border border-editor-border-strong bg-white/[0.02] focus-within:border-muted">
          <label htmlFor="tone-request" className="sr-only">
            Describe a tone change
          </label>
          <textarea
            id="tone-request"
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSending || !presetLoaded}
            placeholder={
              presetLoaded
                ? 'e.g. more gain, tighter low end, a slower delay…'
                : 'Load a preset to start'
            }
            className="block min-h-[148px] w-full resize-y bg-transparent px-4 pb-1.5 pt-4 text-sm leading-relaxed text-primary placeholder:text-muted focus-visible:shadow-none disabled:opacity-60 max-sm:min-h-[96px]"
          />
          <div className="flex items-center gap-2.5 py-2.5 pl-3.5 pr-2.5">
            <p className="text-[11px] text-muted max-sm:hidden">
              {isSending
                ? 'Bender is reasoning and editing — this can take 5–20 seconds.'
                : 'Enter to send · Shift + Enter for a new line'}
            </p>
            <button
              type="submit"
              disabled={isSending || !presetLoaded || input.trim() === ''}
              className="btn-primary ml-auto px-5 text-[13px]"
            >
              {isSending ? 'Working…' : 'Send'}
            </button>
          </div>
        </div>
      </form>

      <p className="rule-note mt-3.5">
        Bender analyses your preset, proposes changes, and shows a preview for you to review.
      </p>
    </div>
  );
}

/** The request that produced the turn at `index`, for a retry affordance. */
function lastRequestBefore(conversation: ConversationTurn[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const turn = conversation[i];
    if (turn.role === 'user') return turn.text;
  }
  return null;
}

interface TurnProps {
  turn: ConversationTurn;
  lastRequest: string | null;
  retryable: boolean;
  onRetry: (text: string) => void;
}

function Turn({ turn, lastRequest, retryable, onRetry }: TurnProps) {
  if (turn.role === 'user') {
    return (
      <p className="max-w-[80%] self-end whitespace-pre-wrap rounded-editor rounded-br-[2px] bg-white/[0.055] px-3.5 py-2.5 text-sm leading-relaxed text-primary">
        {turn.text}
      </p>
    );
  }

  if (turn.role === 'error') {
    return (
      <div className="flex gap-3 rounded-editor border border-danger/40 bg-danger/[0.09] px-4 py-3.5">
        <span aria-hidden="true" className="flex-none leading-snug text-danger">
          !
        </span>
        <div className="min-w-0">
          <strong className="block text-[13px] font-semibold text-primary">
            Bender hit a problem
          </strong>
          <p className="mt-1.5 text-[13px] leading-normal text-secondary">{turn.text}</p>
          {turn.hint ? <p className="mt-1 text-xs text-muted">{turn.hint}</p> : null}
          {retryable && lastRequest ? (
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => onRetry(lastRequest)} className="btn-pill">
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[84%]">
      {turn.activity.length > 0 ? <ActivitySteps items={turn.activity} /> : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-secondary">{turn.text}</p>
      {turn.truncated ? (
        <p className="mt-2 text-xs text-warning">
          Bender ran out of steps before finishing — review the changes and ask it to continue.
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
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
        {(turn.latencyMs / 1000).toFixed(1)}s
      </p>
    </div>
  );
}

function ActivitySteps({ items }: { items: ToolActivityItem[] }) {
  return (
    <ul className="mb-3.5 grid gap-2.5">
      {items.map((item) => (
        <li key={item.key} className="step" data-state={item.ok ? 'done' : 'failed'}>
          <span>
            {item.verb}
            {item.detail ? <span className="text-muted"> — {item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The backend answers in one response rather than streaming, so there is no
 * honest per-step progress to show mid-flight — one active step that says what
 * is happening beats a progress bar that is making its position up.
 */
function Working() {
  return (
    <ul className="grid gap-2.5">
      <li className="step" data-state="active">
        Bender is reading your preset and working out the edits…
      </li>
    </ul>
  );
}

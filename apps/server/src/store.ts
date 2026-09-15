/**
 * In-memory store of active tone sessions.
 *
 * Presets live in server memory for the length of a conversation and are never
 * written to disk. That is the right trade for a hackathon demo: nothing to
 * clean up, nothing to leak, and a restart loses only in-flight work. It also
 * means the server is single-instance -- worth knowing before anyone puts it
 * behind a load balancer.
 */

import { ToneSession, ToolExecutor } from '@bender/tone-tools';
import type { ModelMessage } from './model/provider.js';

export interface StoredSession {
  id: string;
  session: ToneSession;
  executor: ToolExecutor;
  /** Conversation history in provider-neutral form. */
  history: ModelMessage[];
  /** Original upload filename, used to name the download. */
  filename: string;
  createdAt: number;
  lastUsedAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(
    private readonly options: { ttlMs: number; maxSessions: number },
    private readonly now: () => number = Date.now,
  ) {}

  create(id: string, session: ToneSession, filename: string): StoredSession {
    this.evictExpired();

    // Oldest-first eviction under pressure. A session someone is actively
    // using is touched on every message, so it will not be the oldest.
    while (this.sessions.size >= this.options.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }

    const stored: StoredSession = {
      id,
      session,
      executor: new ToolExecutor(session),
      history: [],
      filename,
      createdAt: this.now(),
      lastUsedAt: this.now(),
    };

    this.sessions.set(id, stored);
    return stored;
  }

  get(id: string): StoredSession | undefined {
    const stored = this.sessions.get(id);
    if (!stored) return undefined;

    if (this.now() - stored.lastUsedAt > this.options.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }

    stored.lastUsedAt = this.now();
    return stored;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  evictExpired(): number {
    const cutoff = this.now() - this.options.ttlMs;
    let removed = 0;
    for (const [id, stored] of this.sessions) {
      if (stored.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

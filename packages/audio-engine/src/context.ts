/**
 * Shared AudioContext wrapper for the sori-cut audio pipeline.
 */
export class SoriAudioContext {
  private ctx: AudioContext | null = null;

  get(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.get();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  close(): void {
    this.ctx?.close();
    this.ctx = null;
  }
}

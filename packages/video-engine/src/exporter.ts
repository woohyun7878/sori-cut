/**
 * VideoExporter — FFmpeg.wasm based video export pipeline.
 */
export interface ExportOptions {
  platform: 'reels' | 'shorts' | 'tiktok';
  quality: 'draft' | 'standard' | 'high';
}

export class VideoExporter {
  async export(_videoBlob: Blob, _audioBlob: Blob, _options: ExportOptions): Promise<Blob> {
    // TODO: Implement FFmpeg.wasm pipeline
    throw new Error('Not yet implemented — FFmpeg.wasm integration pending');
  }
}

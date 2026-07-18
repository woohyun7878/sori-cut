import { useRef, useState, type DragEvent } from 'react';
import { useProjectStore, type AudioFile } from '../store/useProjectStore';

const ACCEPTED_AUDIO_TYPES = '.mp3,.wav,.ogg,.flac,.m4a,audio/*';

async function getAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;

    const finalize = (duration: number) => {
      audio.removeAttribute('src');
      audio.load();
      resolve(Number.isFinite(duration) ? duration : 0);
    };

    audio.onloadedmetadata = () => finalize(audio.duration);
    audio.onerror = () => finalize(0);
  });
}

export function DropZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setOriginalAudio = useProjectStore((state) => state.setOriginalAudio);
  const originalAudio = useProjectStore((state) => state.originalAudio);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleFileSelection = async (file: File | null) => {
    if (!file) {
      return;
    }

    setIsLoading(true);
    const url = URL.createObjectURL(file);

    try {
      const duration = await getAudioDuration(url);
      const audioFile: AudioFile = {
        id: crypto.randomUUID(),
        name: file.name,
        blob: file,
        url,
        duration,
      };

      setOriginalAudio(audioFile);
    } catch {
      URL.revokeObjectURL(url);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    await handleFileSelection(event.dataTransfer.files.item(0));
  };

  return (
    <div
      onDragEnter={() => setIsDragging(true)}
      onDragLeave={() => setIsDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDrop={(event) => void handleDrop(event)}
      className={[
        'rounded-3xl border-2 border-dashed bg-gray-900/80 p-8 text-center transition-colors',
        isDragging ? 'border-brand-400 bg-brand-600/10' : 'border-gray-700 hover:border-brand-600/60',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_AUDIO_TYPES}
        className="hidden"
        onChange={(event) => {
          void handleFileSelection(event.target.files?.item(0) ?? null);
          event.currentTarget.value = '';
        }}
      />

      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800 text-3xl">
        🎵
      </div>

      <h3 className="text-xl font-semibold text-white">Drop your audio file here</h3>
      <p className="mt-2 text-sm text-gray-400">or click to browse</p>
      <p className="mt-4 text-xs text-gray-500">MP3 · WAV · OGG · FLAC · M4A</p>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isLoading}
        className="mt-6 inline-flex items-center justify-center rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-900"
      >
        {isLoading ? 'Loading...' : 'Browse Files'}
      </button>

      {originalAudio ? (
        <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/70 p-4 text-left">
          <p className="text-sm font-medium text-white">{originalAudio.name}</p>
          <p className="mt-1 text-xs text-gray-400">
            {originalAudio.duration.toFixed(1)}s · Ready to split
          </p>
        </div>
      ) : null}
    </div>
  );
}

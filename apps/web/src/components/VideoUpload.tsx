import { ChangeEvent, DragEvent, useMemo, useState } from 'react';
import { useProjectStore, type VideoFile } from '../store/useProjectStore';

const ACCEPTED_VIDEO_TYPES = '.mp4,.mov,.webm,video/mp4,video/quicktime,video/webm';
const ACCEPTED_EXTENSIONS = ['.mp4', '.mov', '.webm'];

function formatDuration(duration: number) {
  if (!Number.isFinite(duration)) {
    return '00:00';
  }

  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isSupportedVideo(file: File) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(extension);
}

function getVideoMetadata(file: File) {
  return new Promise<VideoFile>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;

    video.onloadedmetadata = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        blob: file,
        url,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the selected video.'));
    };
  });
}

export function VideoUpload() {
  const video = useProjectStore((state) => state.video);
  const setVideo = useProjectStore((state) => state.setVideo);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metadata = useMemo(() => {
    if (!video) {
      return null;
    }

    return [
      { label: 'Duration', value: formatDuration(video.duration) },
      { label: 'Resolution', value: `${video.width ?? 0} × ${video.height ?? 0}` },
      { label: 'File', value: video.name },
    ];
  }, [video]);

  const handleFile = async (file: File | null) => {
    if (!file) {
      return;
    }

    if (!isSupportedVideo(file)) {
      setError('Supported formats: MP4, MOV, WEBM.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const nextVideo = await getVideoMetadata(file);
      setVideo(nextVideo);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Video upload failed.',
      );
    } finally {
      setIsLoading(false);
      setIsDragging(false);
    }
  };

  const handleInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await handleFile(event.target.files?.item(0) ?? null);
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    await handleFile(event.dataTransfer.files.item(0));
  };

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div
        className={[
          'rounded-3xl border-2 border-dashed bg-gray-950/70 p-8 text-center transition-colors',
          isDragging ? 'border-brand-400 bg-brand-600/10' : 'border-gray-700 hover:border-brand-500/70',
        ].join(' ')}
        onDragEnter={() => setIsDragging(true)}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        <input accept={ACCEPTED_VIDEO_TYPES} className="hidden" id="video-upload" type="file" onChange={(event) => void handleInputChange(event)} />

        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800 text-3xl">
          🎬
        </div>

        <h3 className="text-xl font-semibold text-white">Drop your video file here</h3>
        <p className="mt-2 text-sm text-gray-400">or click to browse</p>
        <p className="mt-4 text-xs text-gray-500">MP4 · MOV · WEBM</p>

        <label
          className="mt-6 inline-flex cursor-pointer items-center justify-center rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          htmlFor="video-upload"
        >
          {isLoading ? 'Loading...' : 'Browse Video'}
        </label>

        {error ? (
          <div className="mt-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {video ? (
          <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/70 p-4 text-left">
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-black">
              <video className="aspect-video w-full bg-black" controls src={video.url} />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {metadata?.map((item) => (
                <div key={item.label} className="rounded-xl border border-gray-800 bg-gray-900/80 p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-gray-500">{item.label}</p>
                  <p className="mt-2 text-sm font-medium text-white">{item.value}</p>
                </div>
              ))}
            </div>

            <button
              className="mt-4 inline-flex rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-red-400/60 hover:text-red-200"
              type="button"
              onClick={() => setVideo(null)}
            >
              Remove Video
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

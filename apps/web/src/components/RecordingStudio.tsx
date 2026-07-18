import { useEffect, useRef, useState } from 'react';
import { useProjectStore, type Recording } from '../store/useProjectStore';
import { WaveformPlayer } from './WaveformPlayer';

type RecordingDraft = Recording;

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function pickRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

export function RecordingStudio() {
  const recordings = useProjectStore((state) => state.recordings);
  const addRecording = useProjectStore((state) => state.addRecording);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [monitoringEnabled, setMonitoringEnabled] = useState(false);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<RecordingDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitoringGainRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const previewRef = useRef<RecordingDraft | null>(null);

  previewRef.current = preview;

  useEffect(() => {
    if (monitoringGainRef.current) {
      monitoringGainRef.current.gain.value = monitoringEnabled ? 0.9 : 0;
    }
  }, [monitoringEnabled]);

  useEffect(
    () => () => {
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current.url);
      }

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
      }

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close();
    },
    [],
  );

  const stopMeters = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setLevel(0);
  };

  const discardPreview = () => {
    if (preview) {
      URL.revokeObjectURL(preview.url);
    }

    setPreview(null);
  };

  const startMetering = () => {
    const analyser = analyserRef.current;

    if (!analyser) {
      return;
    }

    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (const sample of data) {
        const normalized = sample / 128 - 1;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 2.5));
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  };

  const cleanupStream = async () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    analyserRef.current?.disconnect();
    analyserRef.current = null;

    monitoringGainRef.current?.disconnect();
    monitoringGainRef.current = null;

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const stopRecording = async () => {
    if (!isRecording) {
      return;
    }

    stopMeters();
    setIsRecording(false);
    setElapsed(Date.now() - startedAtRef.current);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    await cleanupStream();
  };

  const startRecording = async () => {
    if (isRecording) {
      return;
    }

    discardPreview();
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorderOptions: MediaRecorderOptions = mimeType ? { mimeType } : {};
      const mediaRecorder = new MediaRecorder(stream, recorderOptions);
      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      const monitoringGain = audioContext.createGain();

      analyser.fftSize = 1024;
      monitoringGain.gain.value = monitoringEnabled ? 0.9 : 0;

      sourceNode.connect(analyser);
      sourceNode.connect(monitoringGain);
      monitoringGain.connect(audioContext.destination);

      streamRef.current = stream;
      mediaRecorderRef.current = mediaRecorder;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      monitoringGainRef.current = monitoringGain;
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const finishedAt = Date.now();
        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        });
        const url = URL.createObjectURL(blob);

        setPreview({
          id: crypto.randomUUID(),
          name: `recording-${new Date(finishedAt).toISOString()}.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`,
          blob,
          url,
          duration: Math.max(0, (finishedAt - startedAtRef.current) / 1000),
          createdAt: finishedAt,
        });
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setElapsed(0);
      startMetering();
      intervalRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startedAtRef.current);
      }, 100);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not access microphone.',
      );
      await cleanupStream();
    }
  };

  const saveRecording = () => {
    if (!preview) {
      return;
    }

    addRecording(preview);
    previewRef.current = null;
    setPreview(null);
  };

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-gray-400">
          Record directly in the browser with MediaRecorder and Web Audio API.
        </p>

        <label className="inline-flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={monitoringEnabled}
            onChange={(event) => setMonitoringEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-gray-700 bg-gray-900 text-brand-500 focus:ring-brand-500"
          />
          <span>Hear yourself</span>
        </label>
      </div>

      <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/80 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-gray-400">Recording time</p>
            <p className="mt-1 text-3xl font-semibold text-white">{formatElapsed(elapsed)}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void startRecording()}
              disabled={isRecording}
              className={[
                'rounded-xl px-5 py-3 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed',
                isRecording ? 'bg-red-600/90' : 'bg-brand-600 hover:bg-brand-700 disabled:bg-gray-800',
              ].join(' ')}
            >
              {isRecording ? 'Recording...' : 'Start Recording'}
            </button>

            <button
              type="button"
              onClick={() => void stopRecording()}
              disabled={!isRecording}
              className="rounded-xl border border-red-400/50 bg-red-500/10 px-5 py-3 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-500"
            >
              Stop Recording
            </button>
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span>Input level</span>
            <span>{Math.round(level * 100)}%</span>
          </div>
          <div className="flex h-5 overflow-hidden rounded-full border border-gray-800 bg-gray-900">
            <div
              className="h-full bg-gradient-to-r from-emerald-400 via-brand-500 to-red-500 transition-[width]"
              style={{ width: `${Math.max(6, level * 100)}%` }}
            />
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </div>

      {preview ? (
        <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/70 p-5">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">New Recording</h3>
              <p className="text-sm text-gray-400">Preview before saving.</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={discardPreview}
                className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-semibold text-gray-300 transition-colors hover:border-gray-500"
              >
                Re-record
              </button>
              <button
                type="button"
                onClick={saveRecording}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
              >
                Save
              </button>
            </div>
          </div>

          <WaveformPlayer audioUrl={preview.url} label={preview.name} />
        </div>
      ) : null}

      {recordings.length > 0 ? (
        <div className="mt-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold text-white">Saved Recordings</h3>
            <p className="text-sm text-gray-400">{recordings.length} track(s) saved to project.</p>
          </div>

          <div className="space-y-4">
            {recordings.map((recording) => (
              <WaveformPlayer key={recording.id} audioUrl={recording.url} label={recording.name} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Hero */}
      <header className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="mb-8">
          <h1 className="text-6xl font-bold tracking-tight">
            <span className="text-brand-400">소리</span>
            <span className="text-white">컷</span>
          </h1>
          <p className="mt-2 text-xl text-gray-400 font-medium">sori-cut</p>
        </div>

        <p className="max-w-2xl text-lg text-gray-300 leading-relaxed">
          음악 커버 크리에이터를 위한 올인원 숏폼 편집기
          <br />
          <span className="text-gray-400">
            The all-in-one short-form editor for music cover creators.
          </span>
        </p>

        <div className="mt-12 flex flex-col sm:flex-row gap-4">
          <Link
            to="/studio"
            className="px-8 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-lg transition-colors"
          >
            스튜디오 시작하기
          </Link>
          <a
            href="https://instagram.com/junewoomusic"
            target="_blank"
            rel="noopener noreferrer"
            className="px-8 py-3 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 font-medium text-lg transition-colors"
          >
            @junewoomusic
          </a>
        </div>

        {/* Feature grid */}
        <div className="mt-20 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl w-full">
          <FeatureCard
            emoji="🎛️"
            title="스템 분리"
            subtitle="Stem Splitting"
            description="보컬, 드럼, 베이스, 기타를 자동으로 분리"
          />
          <FeatureCard
            emoji="🎸"
            title="녹음 스튜디오"
            subtitle="Recording Studio"
            description="Web Audio API 기반 고품질 녹음"
          />
          <FeatureCard
            emoji="🎬"
            title="영상 싱크"
            subtitle="Video Sync"
            description="녹음한 오디오를 촬영 영상에 정확히 맞추기"
          />
          <FeatureCard
            emoji="✂️"
            title="타임라인 편집"
            subtitle="Timeline Editor"
            description="트림, 배치, 이펙트를 한 곳에서"
          />
        </div>
      </header>

      {/* Footer */}
      <footer className="py-8 text-center text-sm text-gray-500">
        <p>
          소리(sound) + 컷(cut) — 소리를 자르고, 붙이고, 세상에 내보내세요.
        </p>
        <p className="mt-1">
          Optimized for Reels · Shorts · TikTok (9:16)
        </p>
      </footer>
    </div>
  );
}

function FeatureCard({
  emoji,
  title,
  subtitle,
  description,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-2xl bg-gray-900 border border-gray-800 hover:border-brand-600/50 transition-colors">
      <div className="text-3xl mb-3">{emoji}</div>
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="text-sm text-brand-400">{subtitle}</p>
      <p className="mt-2 text-sm text-gray-400">{description}</p>
    </div>
  );
}

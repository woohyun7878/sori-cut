import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <div className="min-h-screen flex flex-col safe-x">
      {/* Hero */}
      <header className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center md:px-6 md:py-16">
        <div className="mb-6 md:mb-8">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl lg:text-6xl">
            <span className="text-brand-400">소리</span>
            <span className="text-white">컷</span>
          </h1>
          <p className="mt-2 text-lg text-gray-400 font-medium md:text-xl">sori-cut</p>
        </div>

        <p className="max-w-2xl text-base text-gray-300 leading-relaxed md:text-lg">
          The all-in-one short-form editor for music cover creators.
        </p>

        <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4 md:mt-12">
          <Link
            to="/studio"
            className="touch-control px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-base text-center transition-colors md:px-8 md:text-lg"
          >
            Open Studio
          </Link>
          <a
            href="https://instagram.com/junewoomusic"
            target="_blank"
            rel="noopener noreferrer"
            className="touch-control px-6 py-3 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 font-medium text-base text-center transition-colors md:px-8 md:text-lg"
          >
            @junewoomusic
          </a>
        </div>

        {/* Feature grid */}
        <div className="mt-12 grid grid-cols-1 gap-4 w-full max-w-5xl sm:grid-cols-2 sm:gap-5 lg:grid-cols-4 lg:gap-6 md:mt-20">
          <FeatureCard
            emoji="🎛️"
            title="Stem Splitting"
            description="Automatically separate vocals, drums, bass, and guitar"
          />
          <FeatureCard
            emoji="🎸"
            title="Recording Studio"
            description="High-quality recording via Web Audio API"
          />
          <FeatureCard
            emoji="🎬"
            title="Video Sync"
            description="Align your recorded audio precisely to filmed video"
          />
          <FeatureCard
            emoji="✂️"
            title="Timeline Editor"
            description="Trim, arrange, and add effects in one place"
          />
        </div>
      </header>

      {/* Footer */}
      <footer className="py-6 px-4 text-center text-sm text-gray-500 safe-bottom md:py-8">
        <p>
          Trim, layer, and publish your covers.
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
  description,
}: {
  emoji: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-5 rounded-2xl bg-gray-900 border border-gray-800 hover:border-brand-600/50 transition-colors md:p-6">
      <div className="text-2xl mb-2 md:text-3xl md:mb-3">{emoji}</div>
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-gray-400">{description}</p>
    </div>
  );
}

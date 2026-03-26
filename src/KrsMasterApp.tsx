import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BarcodePreview } from './components/BarcodePreview';
import {
  CheckCircleIcon,
  DashboardIcon,
  DescriptionIcon,
  HistoryIcon,
  InfoIcon,
  InventoryIcon,
  ScannerIcon,
  SearchIcon,
  UploadIcon,
} from './components/Icons';
import {
  type BarcodeMatch,
  type MasterFileSummary,
  type MasterRecord,
  findBarcodeMatches,
  formatSimilarity,
  parseMasterFile,
} from './lib/master';
import { fetchServerMaster, uploadMasterToServer } from './lib/api';
import {
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
  type PersistedHistoryItem,
} from './lib/persistence';

type ViewMode = 'dashboard' | 'search' | 'scanner' | 'import';
type ScanStatus = 'idle' | 'starting' | 'active' | 'unsupported' | 'denied' | 'error';
type StorageStatus = 'idle' | 'loading' | 'loaded' | 'saving' | 'error';
type DetectorResult = { rawValue?: string };
type ScannerControls = { stop: () => void };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect: (source: CanvasImageSource) => Promise<DetectorResult[]>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

const navItems = [
  { id: 'dashboard' as const, label: '대시보드', icon: <DashboardIcon /> },
  { id: 'search' as const, label: '검색', icon: <SearchIcon /> },
  { id: 'scanner' as const, label: '스캐너', icon: <ScannerIcon /> },
  { id: 'import' as const, label: '업로드', icon: <UploadIcon fill /> },
];

export default function KrsMasterApp() {
  const [view, setView] = useState<ViewMode>('import');
  const [records, setRecords] = useState<MasterRecord[]>([]);
  const [summary, setSummary] = useState<MasterFileSummary | null>(null);
  const [history, setHistory] = useState<PersistedHistoryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [lastScanRaw, setLastScanRaw] = useState('');
  const [scannerEnabled, setScannerEnabled] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>('loading');
  const [storageMessage, setStorageMessage] = useState<string | null>('저장된 마스터와 서버 상태를 확인하고 있습니다.');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanControlsRef = useRef<ScannerControls | null>(null);

  const activeInput = view === 'scanner' ? scanInput : query;
  const matches = useMemo(() => findBarcodeMatches(records, activeInput), [records, activeInput]);
  const exactMatch = matches.find((item) => item.matchType === 'exact');
  const similarMatches = exactMatch ? matches.filter((item) => item !== exactMatch) : matches;

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      setStorageStatus('loading');
      setStorageMessage('저장된 마스터와 서버 상태를 확인하고 있습니다.');

      try {
        const persisted = await loadPersistedState();
        if (cancelled) return;

        if (persisted?.records.length) {
          setRecords(persisted.records);
          setSummary(persisted.summary);
          setHistory(persisted.history);
          setView('dashboard');
          setStorageStatus('loaded');
          setStorageMessage('이 브라우저의 저장된 마스터를 먼저 복원했습니다.');
        } else {
          setStorageStatus('idle');
          setStorageMessage('로컬 저장 마스터가 없습니다. 서버 최신 마스터를 확인합니다.');
        }

        try {
          const remote = await fetchServerMaster();
          if (cancelled || !remote.active) return;

          const shouldSync =
            !persisted?.summary ||
            !persisted.records.length ||
            new Date(remote.active.importedAt).getTime() > new Date(persisted.summary.importedAt).getTime();

          if (shouldSync) {
            const nextHistory = buildNextHistory(persisted?.history ?? [], remote.active.fileName, remote.active);
            await savePersistedState({
              records: remote.records,
              summary: remote.active,
              history: nextHistory,
              savedAt: new Date().toISOString(),
            });

            if (cancelled) return;
            setRecords(remote.records);
            setSummary(remote.active);
            setHistory(nextHistory);
            setView('dashboard');
            setStorageStatus('loaded');
            setStorageMessage('서버의 최신 마스터를 동기화했습니다.');
          }
        } catch {
          if (!persisted?.records.length && !cancelled) {
            setStorageStatus('idle');
            setStorageMessage('서버 연결이 없어 로컬 마스터만 사용 가능합니다.');
          }
        }
      } catch {
        if (cancelled) return;
        setStorageStatus('error');
        setStorageMessage('브라우저 저장소 또는 서버 동기화에 실패했습니다.');
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!scannerEnabled || view !== 'scanner') {
      stopScanner(videoRef, rafRef, streamRef, scanControlsRef);
      return;
    }

    let cancelled = false;

    const startNativeScanner = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });

      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScanStatus('active');

      const detector = new window.BarcodeDetector!({
        formats: ['qr_code', 'ean_13', 'upc_a', 'upc_e', 'code_128', 'code_39'],
      });

      const tick = async () => {
        if (cancelled || !videoRef.current) return;
        if (videoRef.current.readyState >= 2) {
          try {
            const found = await detector.detect(videoRef.current);
            const raw = found[0]?.rawValue?.trim();
            if (raw) {
              setLastScanRaw(raw);
              setScanInput(raw);
            }
          } catch {
            setScanError('카메라 프레임 분석에 실패했습니다. 수동 입력으로도 검색할 수 있습니다.');
          }
        }

        rafRef.current = requestAnimationFrame(() => {
          void tick();
        });
      };

      rafRef.current = requestAnimationFrame(() => {
        void tick();
      });
    };

    const startFallbackScanner = async () => {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      if (cancelled || !videoRef.current) return;

      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result, error) => {
        if (result) {
          const raw = result.getText().trim();
          if (raw) {
            setLastScanRaw(raw);
            setScanInput(raw);
          }
          return;
        }

        if (error && error.name !== 'NotFoundException') {
          setScanError('호환 모드 스캐너가 프레임을 해석하지 못했습니다. 조명을 밝게 하거나 수동 입력을 사용해 주세요.');
        }
      });

      if (cancelled) {
        controls.stop();
        return;
      }

      scanControlsRef.current = { stop: () => controls.stop() };

      const attachedStream = videoRef.current.srcObject;
      if (attachedStream instanceof MediaStream) {
        streamRef.current = attachedStream;
      }

      setScanStatus('active');
      setScanError('BarcodeDetector 미지원 브라우저라 호환 모드로 스캔 중입니다.');
    };

    const start = async () => {
      try {
        setScanStatus('starting');
        setScanError(null);

        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          setScanStatus('unsupported');
          setScanError('이 환경에서는 카메라 접근이 막혀 있습니다. iPhone에서는 HTTPS 주소로 접속해야 카메라 스캔이 동작합니다.');
          return;
        }

        if (window.BarcodeDetector) {
          await startNativeScanner();
        } else {
          await startFallbackScanner();
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          setScanStatus('denied');
          setScanError('카메라 권한이 필요합니다. 권한을 허용하거나 스캔값을 직접 입력해 주세요.');
        } else {
          setScanStatus('error');
          setScanError('카메라를 시작하지 못했습니다. HTTPS 접속과 카메라 권한을 확인해 주세요.');
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopScanner(videoRef, rafRef, streamRef, scanControlsRef);
    };
  }, [scannerEnabled, view]);

  const handleFileUpload = async (file: File) => {
    setUploading(true);
    setUploadMessage(null);
    setStorageStatus('saving');
    setStorageMessage('마스터를 서버와 브라우저 저장소에 반영하고 있습니다.');

    try {
      const parsed = await parseMasterFile(file);
      await uploadMasterToServer(file);

      const nextHistory = buildNextHistory(history, file.name, parsed.summary);
      await savePersistedState({
        records: parsed.records,
        summary: parsed.summary,
        history: nextHistory,
        savedAt: new Date().toISOString(),
      });

      setRecords(parsed.records);
      setSummary(parsed.summary);
      setHistory(nextHistory);
      setView('dashboard');
      setQuery('');
      setScanInput('');
      setLastScanRaw('');
      setStorageStatus('loaded');
      setStorageMessage('업로드한 마스터를 서버와 이 브라우저에 저장했습니다.');
      setUploadMessage(`${parsed.summary.recordCount.toLocaleString()}건을 업로드하고 서버/로컬 저장까지 완료했습니다.`);
    } catch (error) {
      setStorageStatus('error');
      setStorageMessage('파일은 읽었지만 서버 또는 로컬 저장에 실패했습니다.');
      setUploadMessage(error instanceof Error ? error.message : '파일을 읽지 못했습니다.');
    } finally {
      setUploading(false);
    }
  };

  const handleClearLocalMaster = async () => {
    try {
      setStorageStatus('saving');
      setStorageMessage('이 브라우저의 로컬 저장을 삭제하고 있습니다.');
      await clearPersistedState();
      setRecords([]);
      setSummary(null);
      setHistory([]);
      setQuery('');
      setScanInput('');
      setLastScanRaw('');
      setView('import');
      setStorageStatus('idle');
      setStorageMessage('로컬 저장 마스터를 삭제했습니다. 서버 데이터는 유지됩니다.');
      setUploadMessage('이 브라우저의 로컬 저장소를 비웠습니다.');
    } catch {
      setStorageStatus('error');
      setStorageMessage('저장된 마스터 삭제에 실패했습니다.');
    }
  };

  const stats = summary
    ? [
        { label: '마스터 건수', value: summary.recordCount.toLocaleString() },
        { label: '예외 행', value: summary.irregularRows.toLocaleString() },
        { label: '현재 후보', value: matches.length.toLocaleString() },
      ]
    : [
        { label: '마스터 건수', value: '0' },
        { label: '예외 행', value: '0' },
        { label: '현재 후보', value: '0' },
      ];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(209,228,255,0.95),_rgba(246,250,254,0.98)_38%,_#edf3f7_100%)] pb-24 font-sans text-[#171c1f] md:pb-8">
      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/60 bg-[#f6fafe]/80 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <InventoryIcon className="h-6 w-6 text-[#002542]" />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[#002542] md:text-xl">KRS Master</h1>
            <p className="text-[11px] text-[#5b6670]">업로드, 검색, QR/바코드 후보 추천</p>
          </div>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          {navItems.map((item) => (
            <button key={item.id} onClick={() => setView(item.id)} className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${view === item.id ? 'bg-[#d1e4ff] text-[#002542]' : 'text-[#43474d] hover:bg-white/80'}`}>
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-6 pt-24 xl:grid-cols-[minmax(0,1.3fr)_24rem]">
        <div className="space-y-8">
          <StorageBanner status={storageStatus} message={storageMessage} />
          <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {stats.map((item) => (
              <div key={item.label} className="rounded-[1.75rem] bg-white/85 p-5 shadow-[0_10px_40px_rgba(0,37,66,0.07)] backdrop-blur">
                <p className="text-sm text-[#5b6670]">{item.label}</p>
                <p className="mt-2 text-3xl font-black tracking-tight text-[#002542]">{item.value}</p>
              </div>
            ))}
          </section>

          {view === 'dashboard' && <DashboardView summary={summary} onGoImport={() => setView('import')} onClearLocalMaster={handleClearLocalMaster} />}
          {view === 'import' && <ImportView inputRef={inputRef} uploading={uploading} uploadMessage={uploadMessage} onChooseFile={() => inputRef.current?.click()} onFileSelected={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            await handleFileUpload(file);
            event.target.value = '';
          }} />}
          {view === 'search' && <SearchView query={query} setQuery={setQuery} exactMatch={exactMatch} similarMatches={similarMatches} />}
          {view === 'scanner' && <ScannerView videoRef={videoRef} scannerEnabled={scannerEnabled} setScannerEnabled={setScannerEnabled} scanInput={scanInput} setScanInput={setScanInput} lastScanRaw={lastScanRaw} scanStatus={scanStatus} scanError={scanError} exactMatch={exactMatch} similarMatches={similarMatches} onClear={() => {
            setScanInput('');
            setLastScanRaw('');
          }} />}
        </div>

        <aside className="space-y-6">
          <Panel title="최근 업로드" icon={<HistoryIcon className="h-5 w-5" />}>
            {history.length === 0 ? <p className="text-sm text-[#5b6670]">아직 업로드 기록이 없습니다.</p> : history.map((item) => <div key={item.id}><ImportHistory item={item} /></div>)}
          </Panel>
          <Panel title="검색 팁" icon={<InfoIcon className="h-5 w-5" />}>
            <div className="space-y-3 text-sm leading-6 text-[#43474d]">
              <p>서버의 현재 활성 마스터를 기준으로 검색과 스캔 후보를 표시합니다.</p>
              <p>QR 안에 URL이 들어 있어도 숫자 시퀀스를 뽑아 마스터와 비교합니다.</p>
              <p>완전 일치가 아니어도 한두 자리 차이, 앞자리 일치, 뒷자리 일치를 반영해 후보를 보여줍니다.</p>
            </div>
          </Panel>
        </aside>
      </main>

      <nav className="fixed bottom-0 left-0 z-50 flex h-20 w-full items-center justify-around border-t border-[#dfe3e7] bg-white/95 px-4 shadow-[0_-4px_20px_rgba(0,37,66,0.06)] md:hidden">
        {navItems.map((item) => (
          <button key={item.id} onClick={() => setView(item.id)}>
            <NavItem icon={item.icon} label={item.label} active={view === item.id} />
          </button>
        ))}
      </nav>
    </div>
  );
}

function DashboardView({ summary, onGoImport, onClearLocalMaster }: { summary: MasterFileSummary | null; onGoImport: () => void; onClearLocalMaster: () => void }) {
  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Panel title="현재 마스터 상태" icon={<InventoryIcon className="h-5 w-5" />}>
        {summary ? <div className="space-y-4">
          <MetricRow label="파일명" value={summary.fileName} />
          <MetricRow label="총 레코드" value={`${summary.recordCount.toLocaleString()}건`} />
          <MetricRow label="정상 폭" value={`${summary.fixedWidthRows.toLocaleString()}건`} />
          <MetricRow label="예외 폭" value={`${summary.irregularRows.toLocaleString()}건`} />
          <MetricRow label="인코딩" value={summary.encodingLabel} />
          <MetricRow label="업로드 시각" value={formatDate(summary.importedAt)} />
          <div className="flex flex-wrap gap-3 pt-4">
            <button onClick={onGoImport} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">새 마스터 업로드</button>
            <button onClick={onClearLocalMaster} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542]">로컬 저장 삭제</button>
          </div>
        </div> : <EmptyState title="마스터 파일이 없습니다" description="서버에 업로드된 마스터가 없으면 먼저 파일 업로드가 필요합니다." actionLabel="파일 업로드" onAction={onGoImport} />}
      </Panel>
      <Panel title="매칭 방식" icon={<InfoIcon className="h-5 w-5" />}>
        <div className="space-y-4 text-sm leading-6 text-[#43474d]">
          <p>업로드된 마스터는 서버 DB와 브라우저 로컬 캐시에 함께 저장됩니다.</p>
          <p>새 기기에서 접속하면 서버의 활성 마스터를 받아와 자동으로 동기화합니다.</p>
          <p>스캔값은 숫자 추출, 유사도 계산, 상품명 보조 검색을 함께 사용합니다.</p>
        </div>
      </Panel>
    </section>
  );
}

function ImportView({ inputRef, uploading, uploadMessage, onChooseFile, onFileSelected }: { inputRef: React.RefObject<HTMLInputElement | null>; uploading: boolean; uploadMessage: string | null; onChooseFile: () => void; onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void> }) {
  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel title="상품 마스터 업로드" icon={<UploadIcon className="h-5 w-5" />}>
        <input ref={inputRef} type="file" accept=".txt,.dat,.mst,.csv,text/plain,text/csv" className="hidden" onChange={onFileSelected} />
        <button onClick={onChooseFile} className="group flex min-h-[320px] w-full flex-col items-center justify-center rounded-[2rem] border-2 border-dashed border-[#9eb3c7] bg-[#f0f4f8] p-8 transition-colors hover:bg-[#e7f0fb]">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-200 group-hover:scale-110"><UploadIcon className="h-10 w-10 text-[#002542]" /></div>
          <h2 className="mb-2 text-xl font-bold tracking-tight text-[#171c1f]">서버 공용 마스터 업로드</h2>
          <p className="mb-8 text-center text-sm leading-6 text-[#43474d]">업로드 시 서버 DB와 이 브라우저의 캐시가 함께 갱신됩니다.</p>
          <span className="rounded-xl bg-gradient-to-r from-[#002542] to-[#1b3b5a] px-8 py-3 font-bold text-white shadow-lg">파일 선택하기</span>
        </button>
        <AnimatePresence>
          {(uploading || uploadMessage) && <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-5 rounded-[1.5rem] border border-[#efe4c8] bg-[#fffdf8] p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <DescriptionIcon className="h-5 w-5 text-[#002542]" />
                <div>
                  <p className="font-semibold text-[#171c1f]">{uploading ? '파일 처리 중' : '업로드 결과'}</p>
                  <p className="text-sm text-[#5b6670]">{uploadMessage ?? '파일을 파싱하고 있습니다.'}</p>
                </div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${uploading ? 'bg-[#d1e4ff] text-[#002542]' : 'bg-[#dff3e3] text-[#005c29]'}`}>{uploading ? '진행 중' : '완료'}</span>
            </div>
          </motion.div>}
        </AnimatePresence>
      </Panel>
      <Panel title="업로드 양식" icon={<InfoIcon className="h-5 w-5" />}>
        <div className="space-y-5 text-sm leading-6 text-[#43474d]">
          <MetricRow label="바코드" value="13바이트" />
          <MetricRow label="상품명" value="30바이트" />
          <MetricRow label="축약명" value="14바이트" />
          <MetricRow label="인코딩" value="CP949 / EUC-KR" />
          <div className="break-all rounded-2xl bg-[#edf4fb] p-4 font-mono text-[13px] text-[#002542]">8809329050565 천지개벽)new숙취해소100ml    천지개벽100ml</div>
          <p className="text-xs text-[#6b7280]">현재 서버 파서는 고정폭 CP949 파일을 기준으로 처리합니다.</p>
        </div>
      </Panel>
    </section>
  );
}

function SearchView({ query, setQuery, exactMatch, similarMatches }: { query: string; setQuery: React.Dispatch<React.SetStateAction<string>>; exactMatch?: BarcodeMatch; similarMatches: BarcodeMatch[] }) {
  return (
    <section className="space-y-6">
      <Panel title="바코드 검색" icon={<SearchIcon className="h-5 w-5" />}>
        <div className="flex flex-col gap-3 md:flex-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="바코드, 상품명, 축약명으로 검색" className="flex-1 rounded-2xl border border-[#d6e0ea] bg-white px-5 py-4 text-base outline-none focus:border-[#5f9ad5]" />
          <button onClick={() => setQuery('')} className="rounded-2xl bg-[#edf4fb] px-5 py-4 font-semibold text-[#002542]">초기화</button>
        </div>
      </Panel>
      <MatchSection exactMatch={exactMatch} similarMatches={similarMatches} emptyMessage="검색어를 입력하면 후보가 표시됩니다." />
    </section>
  );
}

function ScannerView(props: { videoRef: React.RefObject<HTMLVideoElement | null>; scannerEnabled: boolean; setScannerEnabled: React.Dispatch<React.SetStateAction<boolean>>; scanInput: string; setScanInput: React.Dispatch<React.SetStateAction<string>>; lastScanRaw: string; scanStatus: ScanStatus; scanError: string | null; exactMatch?: BarcodeMatch; similarMatches: BarcodeMatch[]; onClear: () => void }) {
  return (
    <section className="space-y-6">
      <Panel title="QR / 바코드 스캐너" icon={<ScannerIcon className="h-5 w-5" />}>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] border border-[#153049] bg-[#07131d]">
              <video ref={props.videoRef} className="h-full w-full object-cover" muted playsInline />
              {!props.scannerEnabled && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">카메라를 켜면 실시간 스캔을 시작합니다.</div>}
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => props.setScannerEnabled((prev) => !prev)} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">{props.scannerEnabled ? '카메라 끄기' : '카메라 켜기'}</button>
              <button onClick={props.onClear} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542]">스캔 초기화</button>
            </div>
          </div>
          <div className="space-y-4">
            <StatusCard scanStatus={props.scanStatus} scanError={props.scanError} />
            <div className="rounded-[1.75rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><p className="text-sm text-[#5b6670]">최근 스캔 원문</p><p className="mt-2 break-all font-mono text-[#002542]">{props.lastScanRaw || '-'}</p></div>
            <div className="rounded-[1.75rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><label className="text-sm text-[#5b6670]">직접 입력 / 보정</label><input value={props.scanInput} onChange={(event) => props.setScanInput(event.target.value)} placeholder="스캔값을 직접 붙여 넣어도 됩니다" className="mt-3 w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 text-base outline-none focus:border-[#5f9ad5]" /></div>
          </div>
        </div>
      </Panel>
      <MatchSection exactMatch={props.exactMatch} similarMatches={props.similarMatches} emptyMessage="카메라 스캔 또는 직접 입력한 값 기준으로 후보를 보여줍니다." />
    </section>
  );
}

function MatchSection({ exactMatch, similarMatches, emptyMessage }: { exactMatch?: BarcodeMatch; similarMatches: BarcodeMatch[]; emptyMessage: string }) {
  if (!exactMatch && similarMatches.length === 0) return <Panel title="매칭 결과" icon={<SearchIcon className="h-5 w-5" />}><p className="text-sm text-[#5b6670]">{emptyMessage}</p></Panel>;
  return (
    <section className="space-y-6">
      {exactMatch && <Panel title="완전 일치" icon={<CheckCircleIcon className="h-5 w-5" />}><MatchCard match={exactMatch} emphasize /></Panel>}
      <Panel title="유사 후보" icon={<SearchIcon className="h-5 w-5" />}><div className="space-y-4">{similarMatches.map((match) => <div key={`${match.record.barcode}-${match.record.lineNumber}`}><MatchCard match={match} /></div>)}</div></Panel>
    </section>
  );
}

function MatchCard({ match, emphasize = false }: { match: BarcodeMatch; emphasize?: boolean }) {
  return (
    <div className={`rounded-[1.75rem] border p-5 ${emphasize ? 'border-[#b6e1bd] bg-[#eef8ee]' : 'border-[#dce6f0] bg-[#f8fbfd]'}`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-mono text-lg font-bold text-[#002542]">{match.record.barcode}</p>
          <p className="mt-2 text-lg font-bold text-[#171c1f]">{match.record.name || '-'}</p>
          <p className="mt-1 text-sm text-[#5b6670]">축약명: {match.record.shortName || '-'}</p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${emphasize ? 'bg-[#dff3e3] text-[#005c29]' : 'bg-[#e7f0fb] text-[#174f83]'}`}>{match.matchType === 'exact' ? 'EXACT' : match.matchType.toUpperCase()}</span>
          <span className="text-sm text-[#5b6670]">유사도 {formatSimilarity(match.score)}</span>
        </div>
      </div>
      {match.reasons.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{match.reasons.map((reason) => <span key={reason} className="rounded-full border border-[#dce6f0] bg-white px-3 py-1 text-xs text-[#5b6670]">{reason}</span>)}</div>}
      <div className="mt-4"><BarcodePreview value={match.record.barcode} /></div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-[2rem] bg-white/85 p-6 shadow-[0_10px_40px_rgba(0,37,66,0.07)] backdrop-blur md:p-8"><div className="mb-6 flex items-center gap-3 text-[#002542]">{icon}<h2 className="text-xl font-bold tracking-tight">{title}</h2></div>{children}</section>;
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 border-b border-[#edf2f7] py-3 last:border-b-0"><span className="text-sm text-[#5b6670]">{label}</span><span className="text-right font-semibold text-[#171c1f]">{value}</span></div>;
}

function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return <div className="rounded-[1.75rem] border border-[#dae5ef] bg-[#f5f9fc] p-6"><p className="text-lg font-bold text-[#171c1f]">{title}</p><p className="mt-2 text-sm leading-6 text-[#5b6670]">{description}</p><button onClick={onAction} className="mt-5 rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">{actionLabel}</button></div>;
}

function ImportHistory({ item }: { item: PersistedHistoryItem }) {
  return <div className="group"><div className="mb-2 flex items-start justify-between gap-4"><div><h4 className="font-bold text-[#171c1f] transition-colors group-hover:text-[#002542]">{item.name}</h4><p className="mt-1 text-xs text-[#43474d]">{formatDate(item.importedAt)}</p></div><span className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${item.summary.recordCount > 0 ? 'bg-[#e8f7ec] text-[#005c29]' : 'bg-[#ffe7e5] text-[#93000a]'}`}>{item.summary.irregularRows > 0 ? '검수 필요' : '정상'}</span></div><div className="flex items-center gap-4 text-sm text-[#43474d]"><div className="flex items-center gap-1.5"><InventoryIcon className="h-4 w-4 opacity-70" /><span>{item.summary.recordCount.toLocaleString()}건</span></div><div className="flex items-center gap-1.5"><CheckCircleIcon className="h-4 w-4 text-[#002542]" /><span>예외 {item.summary.irregularRows.toLocaleString()}건</span></div></div></div>;
}

function StatusCard({ scanStatus, scanError }: { scanStatus: ScanStatus; scanError: string | null }) {
  const tone = scanStatus === 'active' ? 'bg-[#e8f7ec] text-[#005c29]' : scanStatus === 'error' ? 'bg-[#ffe7e5] text-[#93000a]' : scanStatus === 'unsupported' || scanStatus === 'denied' ? 'bg-[#fff2dd] text-[#8a5100]' : 'bg-[#e7f0fb] text-[#174f83]';
  const label = scanStatus === 'starting' ? '카메라 시작 중' : scanStatus === 'active' ? '실시간 스캔 중' : scanStatus === 'unsupported' ? '브라우저 미지원' : scanStatus === 'denied' ? '권한 필요' : scanStatus === 'error' ? '카메라 오류' : '대기 중';
  return <div className="rounded-[1.75rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><div className="flex items-center justify-between gap-3"><span className="text-sm text-[#5b6670]">스캐너 상태</span><span className={`rounded-full px-3 py-1 text-xs font-bold ${tone}`}>{label}</span></div><p className="mt-3 text-sm leading-6 text-[#5b6670]">{scanError ?? '카메라를 켜면 QR 코드와 바코드를 실시간으로 탐지합니다.'}</p></div>;
}

function StorageBanner({ status, message }: { status: StorageStatus; message: string | null }) {
  const tone = status === 'loaded' ? 'border-[#cbe7d2] bg-[#eef8ee] text-[#005c29]' : status === 'saving' ? 'border-[#cfe0f4] bg-[#eef5fd] text-[#174f83]' : status === 'error' ? 'border-[#f1c5c0] bg-[#fff0ee] text-[#93000a]' : 'border-[#dce6f0] bg-white/85 text-[#5b6670]';
  return <div className={`rounded-[1.5rem] border px-5 py-4 text-sm shadow-[0_6px_24px_rgba(0,37,66,0.04)] ${tone}`}>{message}</div>;
}

function NavItem({ icon, label, active = false }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return <div className={`flex flex-col items-center justify-center px-3 py-1 transition-all ${active ? 'rounded-2xl bg-[#d1e4ff] text-[#002542]' : 'text-[#43474d]'}`}><div className="flex h-6 w-6 items-center justify-center">{icon}</div><span className="mt-1 text-[10px] font-bold tracking-wider">{label}</span></div>;
}

function buildNextHistory(history: PersistedHistoryItem[], fileName: string, summary: MasterFileSummary) {
  return [{ id: createHistoryId(), name: fileName, importedAt: summary.importedAt, summary }, ...history].slice(0, 8);
}

function stopScanner(videoRef: React.RefObject<HTMLVideoElement | null>, rafRef: React.RefObject<number | null>, streamRef: React.RefObject<MediaStream | null>, scanControlsRef: React.RefObject<ScannerControls | null>) {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
  if (scanControlsRef.current) {
    scanControlsRef.current.stop();
    scanControlsRef.current = null;
  }
  if (streamRef.current) {
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }
  if (videoRef.current) {
    videoRef.current.pause();
    videoRef.current.srcObject = null;
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('ko-KR');
}

function createHistoryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

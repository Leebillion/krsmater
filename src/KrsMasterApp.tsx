import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { BarcodePreview } from './components/BarcodePreview';
import { BundleIcon, CheckCircleIcon, DescriptionIcon, HistoryIcon, InfoIcon, InventoryIcon, ScannerIcon, SearchIcon, UploadIcon } from './components/Icons';
import {
  createBundleReport,
  deleteSavedConvertSet,
  deleteBundleReport,
  fetchSavedConvertSet,
  downloadBundleReportDb,
  fetchBundleMasterStatus,
  fetchServerMaster,
  listSavedConvertSets,
  saveConvertSet,
  listBundleReports,
  searchBundleMaster,
  uploadInventoryPhoto,
  updateBundleReport,
  type BundleMasterRecord,
  type BundleMasterSummary,
  type BundleReportInput,
  type BundleReportRow,
  type ConvertSaveSourceType,
  type InventoryPhotoRow,
  type InventoryPhotoSummary,
  type SavedConvertRow,
  type SavedConvertSetSummary,
  uploadBundleMaster,
  uploadMasterToServer,
} from './lib/api';
import { parseConversionFile, type ConvertedBarcodeItem, type ConvertedBarcodeSummary } from './lib/converter';
import {
  clearPersistedPhotoOcrState,
  clearPersistedState,
  loadPersistedPhotoOcrState,
  loadPersistedState,
  savePersistedPhotoOcrState,
  savePersistedState,
  type PersistedHistoryItem,
} from './lib/persistence';
import { type BarcodeMatch, type MasterFileSummary, type MasterRecord, findBarcodeMatches, formatSimilarity, parseMasterFile } from './lib/master';

type ViewMode = 'scanner' | 'search' | 'bundle' | 'import' | 'convert';
type BundleTab = 'report' | 'reportStatus' | 'lookup';
type ScanStatus = 'idle' | 'starting' | 'active' | 'unsupported' | 'denied' | 'error';
type ScanFeedback = 'idle' | 'scanning' | 'success';
type StorageStatus = 'idle' | 'loading' | 'loaded' | 'saving' | 'error';
type UpdateBannerState = 'hidden' | 'updateReady' | 'offlineReady';
type DetectorResult = { rawValue?: string };
type ScannerControls = {
  stop: () => void;
  streamVideoConstraintsApply?: (constraints: MediaTrackConstraints, trackFilter?: (track: MediaStreamTrack) => boolean) => Promise<void>;
};
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => { detect: (source: CanvasImageSource) => Promise<DetectorResult[]> };
type AppDraftState = {
  view: ViewMode;
  bundleTab: BundleTab;
  query: string;
  submittedQuery: string;
  scanInput: string;
  bundleLookupQuery: string;
  convertQuery: string;
  bundleForm: BundleReportInput;
  editingReportId: number | null;
  editingReportForm: BundleReportInput;
};
type SavedConvertSelection = {
  file: number | '';
  photo: number | '';
};
type SavedConvertMeta = {
  savedName: string;
  updatedAt: string;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

const navItems = [
  { id: 'scanner' as const, label: '스캐너', icon: <ScannerIcon /> },
  { id: 'search' as const, label: '검색', icon: <SearchIcon /> },
  { id: 'bundle' as const, label: '번들', icon: <BundleIcon /> },
  { id: 'convert' as const, label: '변환', icon: <DescriptionIcon /> },
  { id: 'import' as const, label: '업로드', icon: <UploadIcon fill /> },
];
const scannerPreferenceKey = 'krs-master-scanner-enabled';
const appDraftKey = 'krs-master-app-draft-v1';

const emptyBundleForm: BundleReportInput = {
  bundleName: '',
  bundleBarcode: '',
  quantity: '',
  itemBarcode: '',
  itemName: '',
};
const emptyAppDraft: AppDraftState = {
  view: 'scanner',
  bundleTab: 'report',
  query: '',
  submittedQuery: '',
  scanInput: '',
  bundleLookupQuery: '',
  convertQuery: '',
  bundleForm: emptyBundleForm,
  editingReportId: null,
  editingReportForm: emptyBundleForm,
};

export default function KrsMasterApp() {
  const [view, setView] = useState<ViewMode>('scanner');
  const [records, setRecords] = useState<MasterRecord[]>([]);
  const [summary, setSummary] = useState<MasterFileSummary | null>(null);
  const [history, setHistory] = useState<PersistedHistoryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [lastScanRaw, setLastScanRaw] = useState('');
  const [scannerEnabled, setScannerEnabled] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>('loading');
  const [storageMessage, setStorageMessage] = useState<string | null>('저장된 마스터와 서버 상태를 확인하고 있습니다.');
  const [updateBanner, setUpdateBanner] = useState<UpdateBannerState>('hidden');
  const [bundleTab, setBundleTab] = useState<BundleTab>('report');
  const [bundleForm, setBundleForm] = useState<BundleReportInput>(emptyBundleForm);
  const [bundleReportBusy, setBundleReportBusy] = useState(false);
  const [bundleReportMessage, setBundleReportMessage] = useState<string | null>(null);
  const [bundleMasterSummary, setBundleMasterSummary] = useState<BundleMasterSummary | null>(null);
  const [bundleMasterBusy, setBundleMasterBusy] = useState(false);
  const [bundleMasterMessage, setBundleMasterMessage] = useState<string | null>(null);
  const [bundleLookupQuery, setBundleLookupQuery] = useState('');
  const [bundleLookupItems, setBundleLookupItems] = useState<BundleMasterRecord[]>([]);
  const [bundleLookupBusy, setBundleLookupBusy] = useState(false);
  const [bundleLookupMessage, setBundleLookupMessage] = useState<string | null>('상품명 또는 바코드로 검색해 주세요.');
  const [convertSummary, setConvertSummary] = useState<ConvertedBarcodeSummary | null>(null);
  const [convertedItems, setConvertedItems] = useState<ConvertedBarcodeItem[]>([]);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertMessage, setConvertMessage] = useState<string | null>('엑셀 또는 CSV 파일을 올리면 바코드 리스트로 변환합니다.');
  const [convertWarnings, setConvertWarnings] = useState<string[]>([]);
  const [convertQuery, setConvertQuery] = useState('');
  const [convertSaveName, setConvertSaveName] = useState('');
  const [convertSavedMeta, setConvertSavedMeta] = useState<SavedConvertMeta | null>(null);
  const [photoSummary, setPhotoSummary] = useState<InventoryPhotoSummary | null>(null);
  const [photoRows, setPhotoRows] = useState<InventoryPhotoRow[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>('재고현황 표 사진을 올리면 상품코드와 상품명을 추출합니다.');
  const [photoWarnings, setPhotoWarnings] = useState<string[]>([]);
  const [photoSaveBusy, setPhotoSaveBusy] = useState(false);
  const [photoServerSaveName, setPhotoServerSaveName] = useState('');
  const [photoSavedMeta, setPhotoSavedMeta] = useState<SavedConvertMeta | null>(null);
  const [photoProgress, setPhotoProgress] = useState(0);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoPreviewName, setPhotoPreviewName] = useState<string | null>(null);
  const [photoPreviewMeta, setPhotoPreviewMeta] = useState<string | null>(null);
  const [savedConvertSets, setSavedConvertSets] = useState<SavedConvertSetSummary[]>([]);
  const [savedConvertBusy, setSavedConvertBusy] = useState(false);
  const [savedConvertMessage, setSavedConvertMessage] = useState<string | null>(null);
  const [savedConvertSelection, setSavedConvertSelection] = useState<SavedConvertSelection>({ file: '', photo: '' });
  const [bundleReportRows, setBundleReportRows] = useState<BundleReportRow[]>([]);
  const [bundleReportRowsBusy, setBundleReportRowsBusy] = useState(false);
  const [bundleReportRowsMessage, setBundleReportRowsMessage] = useState<string | null>(null);
  const [editingReportId, setEditingReportId] = useState<number | null>(null);
  const [editingReportForm, setEditingReportForm] = useState<BundleReportInput>(emptyBundleForm);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const bundleMasterInputRef = useRef<HTMLInputElement | null>(null);
  const convertInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanControlsRef = useRef<ScannerControls | null>(null);
  const scanFeedbackTimeoutRef = useRef<number | null>(null);

  const activeInput = view === 'scanner' ? scanInput : view === 'search' ? submittedQuery : '';
  const matches = useMemo(() => findBarcodeMatches(records, activeInput), [records, activeInput]);
  const exactMatch = matches.find((item) => item.matchType === 'exact');
  const similarMatches = exactMatch ? matches.filter((item) => item !== exactMatch) : matches;
  const filteredConvertedItems = useMemo(() => {
    const keyword = convertQuery.trim().toLowerCase();
    if (!keyword) return convertedItems;
    return convertedItems.filter((item) => item.barcode.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword));
  }, [convertQuery, convertedItems]);
  const masterRecordByBarcode = useMemo(() => {
    const map = new Map<string, MasterRecord>();
    for (const record of records) {
      map.set(record.barcode, record);
    }
    return map;
  }, [records]);
  const fileSavedConvertSets = useMemo(
    () => savedConvertSets.filter((item) => item.sourceType === 'file'),
    [savedConvertSets],
  );
  const photoSavedConvertSets = useMemo(
    () => savedConvertSets.filter((item) => item.sourceType === 'photo'),
    [savedConvertSets],
  );
  const searchValidation = getSearchValidation(query);
  const searchEmptyMessage = view === 'scanner'
    ? '스캔 또는 직접 입력 결과를 기준으로 후보를 보여드립니다.'
    : searchValidation.message ?? '검색어를 입력한 뒤 검색 버튼을 눌러 주세요.';

  const clearScanFeedbackTimeout = () => {
    if (scanFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(scanFeedbackTimeoutRef.current);
      scanFeedbackTimeoutRef.current = null;
    }
  };

  const markScanSuccess = (raw: string) => {
    setLastScanRaw(raw);
    setScanInput(raw);
    setScanFeedback('success');
    clearScanFeedbackTimeout();
    scanFeedbackTimeoutRef.current = window.setTimeout(() => {
      setScanFeedback(scannerEnabled ? 'scanning' : 'idle');
      scanFeedbackTimeoutRef.current = null;
    }, 1200);
  };

  const updateScannerEnabled = (enabled: boolean) => {
    setScannerEnabled(enabled);
    try {
      window.localStorage.setItem(scannerPreferenceKey, enabled ? 'true' : 'false');
    } catch {
      // Ignore storage failures and keep scanner behavior local to the current session.
    }
  };

  const toggleScannerEnabled = () => {
    updateScannerEnabled(!scannerEnabled);
  };

  useEffect(() => {
    try {
      setScannerEnabled(true);
      window.localStorage.setItem(scannerPreferenceKey, 'true');
      const storedDraft = window.localStorage.getItem(appDraftKey);
      if (storedDraft) {
        const draft = JSON.parse(storedDraft) as Partial<AppDraftState>;
        if (draft.view === 'scanner' || draft.view === 'search' || draft.view === 'bundle' || draft.view === 'import' || draft.view === 'convert') setView(draft.view);
        if (draft.bundleTab === 'report' || draft.bundleTab === 'reportStatus' || draft.bundleTab === 'lookup') setBundleTab(draft.bundleTab);
        if (typeof draft.query === 'string') setQuery(draft.query);
        if (typeof draft.submittedQuery === 'string') setSubmittedQuery(draft.submittedQuery);
        if (typeof draft.scanInput === 'string') setScanInput(draft.scanInput);
        if (typeof draft.bundleLookupQuery === 'string') setBundleLookupQuery(draft.bundleLookupQuery);
        if (typeof draft.convertQuery === 'string') setConvertQuery(draft.convertQuery);
        if (draft.bundleForm) setBundleForm({ ...emptyBundleForm, ...draft.bundleForm });
        if (typeof draft.editingReportId === 'number' || draft.editingReportId === null) setEditingReportId(draft.editingReportId);
        if (draft.editingReportForm) setEditingReportForm({ ...emptyBundleForm, ...draft.editingReportForm });
      }
    } catch {
      // Ignore preference restore failures.
    }
  }, []);

  useEffect(() => {
    try {
      const draft: AppDraftState = {
        view,
        bundleTab,
        query,
        submittedQuery,
        scanInput,
        bundleLookupQuery,
        convertQuery,
        bundleForm,
        editingReportId,
        editingReportForm,
      };
      window.localStorage.setItem(appDraftKey, JSON.stringify(draft));
    } catch {
      // Ignore draft persistence failures.
    }
  }, [view, bundleTab, query, submittedQuery, scanInput, bundleLookupQuery, convertQuery, bundleForm, editingReportId, editingReportForm]);

  useEffect(() => {
    if (!photoBusy) {
      setPhotoProgress((prev) => (prev >= 100 ? 100 : 0));
      return;
    }

    setPhotoProgress((prev) => (prev > 0 ? prev : 8));
    const timer = window.setInterval(() => {
      setPhotoProgress((prev) => {
        if (prev >= 92) return prev;
        if (prev < 28) return prev + 8;
        if (prev < 58) return prev + 6;
        if (prev < 78) return prev + 4;
        return prev + 2;
      });
    }, 450);

    return () => window.clearInterval(timer);
  }, [photoBusy]);

  useEffect(() => {
    return () => {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    };
  }, [photoPreviewUrl]);

  useEffect(() => {
    const handleUpdateReady = () => setUpdateBanner('updateReady');
    const handleOfflineReady = () => setUpdateBanner((prev) => (prev === 'hidden' ? 'offlineReady' : prev));
    window.addEventListener('krs-pwa-update-ready', handleUpdateReady);
    window.addEventListener('krs-pwa-offline-ready', handleOfflineReady);
    return () => {
      window.removeEventListener('krs-pwa-update-ready', handleUpdateReady);
      window.removeEventListener('krs-pwa-offline-ready', handleOfflineReady);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const persisted = await loadPersistedState();
        if (cancelled) return;
        if (persisted?.records.length) {
          setRecords(persisted.records);
          setSummary(persisted.summary);
          setHistory(persisted.history);
          setStorageStatus('loaded');
          setStorageMessage('이 브라우저의 저장 마스터를 복원했습니다.');
        } else {
          setStorageStatus('idle');
          setStorageMessage('로컬 저장 마스터가 없습니다. 서버 최신 마스터를 확인합니다.');
        }
        try {
          const remote = await fetchServerMaster();
          if (cancelled || !remote.active) return;
          const shouldSync = !persisted?.summary || !persisted.records.length || new Date(remote.active.importedAt).getTime() > new Date(persisted.summary.importedAt).getTime();
          if (shouldSync) {
            const nextHistory = buildNextHistory(persisted?.history ?? [], remote.active.fileName, remote.active);
            await savePersistedState({ records: remote.records, summary: remote.active, history: nextHistory, savedAt: new Date().toISOString() });
            if (cancelled) return;
            setRecords(remote.records);
            setSummary(remote.active);
            setHistory(nextHistory);
            setStorageStatus('loaded');
            setStorageMessage('서버 마스터 동기화 완료');
          }
        } catch {
          if (!persisted?.records.length && !cancelled) {
            setStorageStatus('idle');
            setStorageMessage('서버 연결이 없어 로컬 마스터만 사용할 수 있습니다.');
          }
        }
      } catch {
        if (!cancelled) {
          setStorageStatus('error');
          setStorageMessage('브라우저 저장소 또는 서버 동기화에 실패했습니다.');
        }
      }
    };
    const loadBundle = async () => {
      try {
        const result = await fetchBundleMasterStatus();
        if (!cancelled) setBundleMasterSummary(result.active);
      } catch {
        if (!cancelled) setBundleMasterMessage('번들 마스터 상태를 불러오지 못했습니다.');
      }
    };
    const loadPhotoOcr = async () => {
      try {
        const persisted = await loadPersistedPhotoOcrState();
        if (!cancelled && persisted) {
          setPhotoSummary(persisted.summary);
          setPhotoRows(persisted.rows);
          setPhotoWarnings(persisted.warnings);
          if (persisted.rows.length) {
            setPhotoMessage(`임시 저장된 사진 OCR 결과 ${persisted.rows.length.toLocaleString()}건을 복원했습니다.`);
          }
        }
      } catch {
        if (!cancelled) {
          setPhotoMessage('사진 OCR 임시 저장 복원에 실패했습니다.');
        }
      }
    };
    const loadSavedConvert = async () => {
      try {
        const result = await listSavedConvertSets();
        if (!cancelled) {
          setSavedConvertSets(result.items);
          if (!result.items.length) {
            setSavedConvertMessage('저장된 변환 결과가 없습니다.');
          }
        }
      } catch {
        if (!cancelled) {
          setSavedConvertMessage('저장된 변환 결과 목록을 불러오지 못했습니다.');
        }
      }
    };
    void load();
    void loadBundle();
    void loadPhotoOcr();
    void loadSavedConvert();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!scannerEnabled || view !== 'scanner') {
      clearScanFeedbackTimeout();
      setScanFeedback('idle');
      stopScanner(videoRef, rafRef, streamRef, scanControlsRef);
      return;
    }
    let cancelled = false;
    const start = async () => {
      try {
        setScanStatus('starting');
        setScanFeedback('idle');
        setScanError(null);
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          setScanStatus('unsupported');
          setScanError('현재 환경에서는 카메라 접근이 제한됩니다.');
          return;
        }
        const videoConstraints = buildScannerVideoConstraints();
        if (window.BarcodeDetector) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
          if (cancelled) return;
          streamRef.current = stream;
          if (!videoRef.current) return;
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          await optimizeScannerTrack(stream.getVideoTracks()[0]);
          setScanStatus('active');
          setScanFeedback('scanning');
          const detector = new window.BarcodeDetector({ formats: ['qr_code', 'ean_13', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
          const tick = async () => {
            if (cancelled || !videoRef.current) return;
            try {
              const found = await detector.detect(videoRef.current);
              const raw = found[0]?.rawValue?.trim();
              if (raw) markScanSuccess(raw);
            } catch {
              setScanError('카메라 프레임 분석에 실패했습니다.');
            }
            rafRef.current = requestAnimationFrame(() => void tick());
          };
          rafRef.current = requestAnimationFrame(() => void tick());
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (cancelled || !videoRef.current) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromConstraints({ video: videoConstraints, audio: false }, videoRef.current, (result) => {
            if (!result) return;
            const raw = result.getText().trim();
            if (raw) markScanSuccess(raw);
          });
          scanControlsRef.current = {
            stop: () => controls.stop(),
            streamVideoConstraintsApply: controls.streamVideoConstraintsApply,
          };
          await controls.streamVideoConstraintsApply?.(buildScannerFocusConstraints());
          setScanStatus('active');
          setScanFeedback('scanning');
          setScanError('브라우저 호환 모드로 스캔 중입니다.');
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          setScanStatus('denied');
          setScanError('카메라 권한이 필요합니다.');
        } else {
          setScanStatus('error');
          setScanError('카메라를 시작하지 못했습니다.');
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      clearScanFeedbackTimeout();
      setScanFeedback('idle');
      stopScanner(videoRef, rafRef, streamRef, scanControlsRef);
    };
  }, [scannerEnabled, view]);

  useEffect(() => {
    if (view === 'bundle' && bundleTab === 'reportStatus') {
      void (async () => {
        try {
          setBundleReportRowsBusy(true);
          const result = await listBundleReports();
          setBundleReportRows(result.items);
          setBundleReportRowsMessage(
            result.items.length
              ? `${result.items.length.toLocaleString()}건의 번들 제보가 저장되어 있습니다.`
              : '저장된 번들 제보가 없습니다.',
          );
        } catch (error) {
          setBundleReportRows([]);
          setBundleReportRowsMessage(error instanceof Error ? error.message : '번들 제보 현황을 불러오지 못했습니다.');
        } finally {
          setBundleReportRowsBusy(false);
        }
      })();
    }
  }, [view, bundleTab]);

  const stats = summary ? [
    { label: '마스터 건수', value: summary.recordCount.toLocaleString() },
    { label: '예외 행', value: summary.irregularRows.toLocaleString() },
    { label: '현재 후보', value: matches.length.toLocaleString() },
  ] : [
    { label: '마스터 건수', value: '0' },
    { label: '예외 행', value: '0' },
    { label: '현재 후보', value: '0' },
  ];

  const saveMasterFile = async (file: File) => {
    setUploading(true);
    setUploadMessage(null);
    setStorageStatus('saving');
    setStorageMessage('마스터를 서버와 브라우저 저장소에 반영하고 있습니다.');
    try {
      const parsed = await parseMasterFile(file);
      const serverResult = await uploadMasterToServer(file);
      const normalizedSummary = { ...parsed.summary, fileName: serverResult.summary.fileName };
      const nextHistory = buildNextHistory(history, normalizedSummary.fileName, normalizedSummary);
      await savePersistedState({ records: parsed.records, summary: normalizedSummary, history: nextHistory, savedAt: new Date().toISOString() });
      setRecords(parsed.records);
      setSummary(normalizedSummary);
      setHistory(nextHistory);
      setStorageStatus('loaded');
      setStorageMessage('서버 마스터 동기화 완료');
      setUploadMessage(`${normalizedSummary.recordCount.toLocaleString()}건 업로드 완료`);
      setView('search');
    } catch (error) {
      setStorageStatus('error');
      setStorageMessage('파일은 읽었지만 저장에 실패했습니다.');
      setUploadMessage(error instanceof Error ? error.message : '파일 처리에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  };

  const clearLocalMaster = async () => {
    try {
      setStorageStatus('saving');
      await clearPersistedState();
      setRecords([]);
      setSummary(null);
      setHistory([]);
      setQuery('');
      setScanInput('');
      setLastScanRaw('');
      setStorageStatus('idle');
      setStorageMessage('로컬 저장 마스터를 삭제했습니다.');
      setView('import');
    } catch {
      setStorageStatus('error');
      setStorageMessage('저장된 마스터 삭제에 실패했습니다.');
    }
  };

  const loadBundleReportRows = async (messageOnEmpty?: string) => {
    try {
      setBundleReportRowsBusy(true);
      const result = await listBundleReports();
      setBundleReportRows(result.items);
      setBundleReportRowsMessage(
        result.items.length
          ? `${result.items.length.toLocaleString()}건의 번들 제보가 저장되어 있습니다.`
          : (messageOnEmpty ?? '저장된 번들 제보가 없습니다.'),
      );
    } catch (error) {
      setBundleReportRows([]);
      setBundleReportRowsMessage(error instanceof Error ? error.message : '번들 제보 현황을 불러오지 못했습니다.');
    } finally {
      setBundleReportRowsBusy(false);
    }
  };

  const openBundleReportStatus = async () => {
    setBundleTab('reportStatus');
    await loadBundleReportRows();
  };

  const saveBundleReport = async () => {
    const error = validateBundleForm(bundleForm);
    if (error) {
      setBundleReportMessage(error);
      return;
    }
    try {
      setBundleReportBusy(true);
      const saved = await createBundleReport(bundleForm);
      setBundleReportMessage('번들 제보가 저장되었습니다.');
      setBundleForm(emptyBundleForm);
      await loadBundleReportRows();
      setBundleReportRowsMessage(`번들 제보 #${saved.id}가 저장되었습니다.`);
      setBundleTab('reportStatus');
    } catch (error) {
      setBundleReportMessage(error instanceof Error ? error.message : '번들 제보 저장에 실패했습니다.');
    } finally {
      setBundleReportBusy(false);
    }
  };

  const downloadBundleDb = async () => {
    try {
      setBundleReportBusy(true);
      const blob = await downloadBundleReportDb();
      downloadBlob(blob, `bundle_reports_${formatNowForFile()}.xlsx`);
      setBundleReportMessage('번들 제보 DB를 다운로드했습니다.');
    } catch (error) {
      setBundleReportMessage(error instanceof Error ? error.message : '다운로드에 실패했습니다.');
    } finally {
      setBundleReportBusy(false);
    }
  };

  const uploadBundleMasterFile = async (file: File) => {
    try {
      setBundleMasterBusy(true);
      setBundleMasterMessage('번들 마스터를 업로드하고 있습니다.');
      const result = await uploadBundleMaster(file);
      const status = await fetchBundleMasterStatus();
      setBundleMasterSummary(status.active);
      setBundleMasterMessage(
        result.warnings.length
          ? `번들 마스터 업로드 완료\n${result.warnings.join('\n')}`
          : '번들 마스터 업로드 완료',
      );
      await loadBundleLookup('');
      setBundleTab('lookup');
    } catch (error) {
      setBundleMasterMessage(error instanceof Error ? error.message : '번들 마스터 업로드에 실패했습니다.');
    } finally {
      setBundleMasterBusy(false);
    }
  };

  const loadBundleLookup = async (nextQuery: string) => {
    try {
      setBundleLookupBusy(true);
      const result = await searchBundleMaster(nextQuery);
      setBundleMasterSummary(result.active);
      setBundleLookupItems(result.items);
      setBundleLookupMessage(result.items.length ? `${result.items.length.toLocaleString()}건 조회되었습니다.` : '조회 결과가 없습니다.');
    } catch (error) {
      setBundleLookupItems([]);
      setBundleLookupMessage(error instanceof Error ? error.message : '번들 검색에 실패했습니다.');
    } finally {
      setBundleLookupBusy(false);
    }
  };

  const convertFileToBarcodeList = async (file: File) => {
    try {
      setConvertBusy(true);
      setConvertMessage(null);
      const result = await parseConversionFile(file);
      setConvertedItems(result.items);
      setConvertSummary(result.summary);
      setConvertWarnings(result.warnings);
      setConvertQuery('');
      setConvertSaveName(buildDefaultSaveName(result.summary.fileName));
      setConvertSavedMeta(null);
      setConvertMessage(
        `${result.summary.recordCount.toLocaleString()}건을 바코드 리스트로 변환했습니다.${result.warnings.length ? ` 제외 ${result.warnings.length.toLocaleString()}건` : ''}`,
      );
      setView('convert');
    } catch (error) {
      setConvertedItems([]);
      setConvertSummary(null);
      setConvertWarnings([]);
      setConvertMessage(error instanceof Error ? error.message : '파일 변환에 실패했습니다.');
    } finally {
      setConvertBusy(false);
    }
  };

  const convertInventoryPhoto = async (file: File) => {
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

    if (!isImage && !isPdf) {
      setPhotoMessage('이미지 또는 PDF 파일만 업로드할 수 있습니다.');
      return;
    }

    setPhotoPreviewName(file.name);
    setPhotoPreviewMeta(`${isPdf ? 'PDF 문서' : '이미지'} / ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return isImage ? URL.createObjectURL(file) : null;
    });

    try {
      setPhotoBusy(true);
      setPhotoProgress(8);
      setPhotoMessage(null);
      const result = await uploadInventoryPhoto(file);
      setPhotoPreviewName(result.summary.fileName);
      const hydratedRows = result.items.map((item) => ({
        ...item,
        name: masterRecordByBarcode.get(item.barcode)?.name ?? item.name,
      }));
      setPhotoRows((prev) => mergePhotoRows(prev, hydratedRows));
      setPhotoSummary((prev) => ({
        fileName: prev ? `${prev.fileName}, ${result.summary.fileName}` : result.summary.fileName,
        importedAt: result.summary.importedAt,
        recordCount: (prev?.recordCount ?? 0) + result.items.length,
      }));
      setPhotoServerSaveName((prev) => prev || buildDefaultSaveName(result.summary.fileName));
      setPhotoSavedMeta(null);
      setPhotoWarnings((prev) => [...prev, ...result.warnings]);
      setPhotoMessage(
        `${result.items.length.toLocaleString()}건을 추가 추출했습니다. 표에서 바로 수정한 뒤 임시 저장 또는 엑셀 다운로드할 수 있습니다.`,
      );
      setPhotoProgress(100);
      setView('convert');
    } catch (error) {
      setPhotoProgress(0);
      setPhotoMessage(error instanceof Error ? error.message : '재고현황 표 사진 변환에 실패했습니다.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const updatePhotoRow = (index: number, key: 'barcode' | 'name', value: string) => {
    setPhotoRows((prev) => prev.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      if (key === 'barcode') {
        const barcode = value.replace(/\D/g, '');
        return {
          ...row,
          barcode,
          name: masterRecordByBarcode.get(barcode)?.name ?? row.name,
        };
      }
      return {
        ...row,
        [key]: value,
      };
    }));
  };

  const downloadPhotoRowsAsExcel = () => {
    if (photoRows.length === 0) {
      setPhotoMessage('다운로드할 추출 결과가 없습니다.');
      return;
    }

    const workbook = XLSX.utils.book_new();
    const rows = photoRows.map((row) => ({
      상품코드: row.barcode,
      상품명: row.name,
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, '재고현황변환');
    const fileName = `inventory_photo_${formatNowForFile()}.xlsx`;
    const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    downloadBlob(
      new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      fileName,
    );
  };

  const savePhotoRowsToDevice = async () => {
    try {
      setPhotoSaveBusy(true);
      await savePersistedPhotoOcrState({
        summary: photoSummary,
        rows: photoRows,
        warnings: photoWarnings,
        savedAt: new Date().toISOString(),
      });
      setPhotoMessage(`사진 OCR 결과 ${photoRows.length.toLocaleString()}건을 이 기기에 임시 저장했습니다.`);
    } catch {
      setPhotoMessage('사진 OCR 결과 임시 저장에 실패했습니다.');
    } finally {
      setPhotoSaveBusy(false);
    }
  };

  const clearSavedPhotoRows = async () => {
    try {
      setPhotoSaveBusy(true);
      await clearPersistedPhotoOcrState();
      setPhotoSummary(null);
      setPhotoRows([]);
      setPhotoWarnings([]);
      setPhotoSavedMeta(null);
      setPhotoMessage('사진 OCR 임시 저장 데이터를 삭제했습니다.');
    } catch {
      setPhotoMessage('사진 OCR 임시 저장 데이터 삭제에 실패했습니다.');
    } finally {
      setPhotoSaveBusy(false);
    }
  };

  const refreshSavedConvertSets = async (nextMessage?: string) => {
    try {
      const result = await listSavedConvertSets();
      setSavedConvertSets(result.items);
      if (nextMessage) {
        setSavedConvertMessage(nextMessage);
      } else if (!result.items.length) {
        setSavedConvertMessage('저장된 변환 결과가 없습니다.');
      }
    } catch (error) {
      setSavedConvertMessage(error instanceof Error ? error.message : '저장된 변환 결과 목록을 불러오지 못했습니다.');
    }
  };

  const saveCurrentConvertResult = async (sourceType: ConvertSaveSourceType) => {
    const name = (sourceType === 'file' ? convertSaveName : photoServerSaveName).trim();
    const rows: SavedConvertRow[] = sourceType === 'file'
      ? convertedItems.map((item) => ({ barcode: item.barcode, name: item.name, rowNumber: item.rowNumber }))
      : photoRows.map((item) => ({ barcode: item.barcode, name: item.name, rowNumber: item.rowNumber }));
    const sourceFileName = sourceType === 'file' ? (convertSummary?.fileName ?? '') : (photoSummary?.fileName ?? '');

    if (!name) {
      const message = '저장 이름을 입력해 주세요.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
      return;
    }

    if (!rows.length || !sourceFileName) {
      const message = sourceType === 'file' ? '저장할 변환 결과가 없습니다.' : '저장할 사진 OCR 결과가 없습니다.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
      return;
    }

    try {
      setSavedConvertBusy(true);
      const result = await saveConvertSet({ name, sourceType, sourceFileName, rows });
      await refreshSavedConvertSets(`${result.item.name} 저장본을 서버 DB에 저장했습니다.`);
      setSavedConvertSelection((prev) => ({ ...prev, [sourceType]: result.item.id }));
      if (sourceType === 'file') {
        setConvertSavedMeta({ savedName: result.item.name, updatedAt: result.item.updatedAt });
        setConvertSummary((prev) => (prev ? { ...prev, fileName: result.item.sourceFileName, savedName: result.item.name } : prev));
        setConvertMessage(`${result.item.recordCount.toLocaleString()}건 변환 결과를 서버 저장했습니다.`);
      } else {
        setPhotoSavedMeta({ savedName: result.item.name, updatedAt: result.item.updatedAt });
        setPhotoSummary((prev) => (prev ? { ...prev, fileName: result.item.sourceFileName, savedName: result.item.name } : prev));
        setPhotoMessage(`${result.item.recordCount.toLocaleString()}건 사진 OCR 결과를 서버 저장했습니다.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '변환 결과 저장에 실패했습니다.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
    } finally {
      setSavedConvertBusy(false);
    }
  };

  const loadSavedConvertResult = async (sourceType: ConvertSaveSourceType, rawId: string) => {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id) || id < 1) {
      setSavedConvertSelection((prev) => ({ ...prev, [sourceType]: '' }));
      return;
    }

    try {
      setSavedConvertBusy(true);
      const result = await fetchSavedConvertSet(id);
      const item = result.item;
      setSavedConvertSelection((prev) => ({ ...prev, [sourceType]: item.id }));

      if (sourceType === 'file') {
        const loadedItems = item.rows.map((row) => ({ barcode: row.barcode, name: row.name, rowNumber: row.rowNumber }));
        setConvertedItems(loadedItems);
        setConvertWarnings([]);
        setConvertQuery('');
        setConvertSummary({
          fileName: item.sourceFileName,
          importedAt: item.updatedAt,
          recordCount: item.recordCount,
          skippedRows: 0,
          savedName: item.name,
        });
        setConvertSavedMeta({ savedName: item.name, updatedAt: item.updatedAt });
        setConvertSaveName(item.name);
        setConvertMessage(`${item.name} 저장본을 불러왔습니다.`);
      } else {
        setPhotoRows(item.rows.map((row) => ({ barcode: row.barcode, name: row.name, rowNumber: row.rowNumber })));
        setPhotoWarnings([]);
        setPhotoSummary({
          fileName: item.sourceFileName,
          importedAt: item.updatedAt,
          recordCount: item.recordCount,
          savedName: item.name,
        });
        setPhotoSavedMeta({ savedName: item.name, updatedAt: item.updatedAt });
        setPhotoServerSaveName(item.name);
        setPhotoMessage(`${item.name} 저장본을 불러왔습니다.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '저장된 변환 결과를 불러오지 못했습니다.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
    } finally {
      setSavedConvertBusy(false);
    }
  };

  const removeSavedConvertResult = async (sourceType: ConvertSaveSourceType) => {
    const selectedId = savedConvertSelection[sourceType];
    if (!selectedId) {
      const message = '삭제할 저장 결과를 먼저 선택해 주세요.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
      return;
    }

    try {
      setSavedConvertBusy(true);
      const selectedSummary = savedConvertSets.find((item) => item.id === selectedId);
      await deleteSavedConvertSet(selectedId);
      await refreshSavedConvertSets(`${selectedSummary?.name ?? '선택한 저장본'}을 삭제했습니다.`);
      setSavedConvertSelection((prev) => ({ ...prev, [sourceType]: '' }));
      if (sourceType === 'file') {
        setConvertSavedMeta(null);
        setConvertMessage('서버 저장 결과를 삭제했습니다.');
      } else {
        setPhotoSavedMeta(null);
        setPhotoMessage('서버 저장 결과를 삭제했습니다.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '저장된 변환 결과 삭제에 실패했습니다.';
      if (sourceType === 'file') setConvertMessage(message);
      else setPhotoMessage(message);
    } finally {
      setSavedConvertBusy(false);
    }
  };

  const startEditBundleReport = (row: BundleReportRow) => {
    setEditingReportId(row.id);
    setEditingReportForm({
      bundleName: row.bundleName,
      bundleBarcode: row.bundleBarcode,
      quantity: String(row.quantity),
      itemBarcode: row.itemBarcode,
      itemName: row.itemName,
    });
    setBundleReportRowsMessage(`제보 #${row.id} 수정 중입니다.`);
  };

  const cancelEditBundleReport = () => {
    setEditingReportId(null);
    setEditingReportForm(emptyBundleForm);
    setBundleReportRowsMessage('수정을 취소했습니다.');
  };

  const saveEditedBundleReport = async () => {
    if (editingReportId === null) return;
    const error = validateBundleForm(editingReportForm);
    if (error) {
      setBundleReportRowsMessage(error);
      return;
    }

    try {
      setBundleReportRowsBusy(true);
      await updateBundleReport(editingReportId, editingReportForm);
      setEditingReportId(null);
      setEditingReportForm(emptyBundleForm);
      await loadBundleReportRows('저장된 번들 제보가 없습니다.');
      setBundleReportRowsMessage('번들 제보를 수정했습니다.');
    } catch (error) {
      setBundleReportRowsMessage(error instanceof Error ? error.message : '번들 제보 수정에 실패했습니다.');
    } finally {
      setBundleReportRowsBusy(false);
    }
  };

  const runSearch = () => {
    if (!searchValidation.canSearch) {
      setSubmittedQuery('');
      return;
    }
    setSubmittedQuery(query.trim());
  };

  const removeBundleReport = async (id: number) => {
    try {
      setBundleReportRowsBusy(true);
      await deleteBundleReport(id);
      if (editingReportId === id) {
        setEditingReportId(null);
        setEditingReportForm(emptyBundleForm);
      }
      await loadBundleReportRows('저장된 번들 제보가 없습니다.');
      setBundleReportRowsMessage('번들 제보를 삭제했습니다.');
    } catch (error) {
      setBundleReportRowsMessage(error instanceof Error ? error.message : '번들 제보 삭제에 실패했습니다.');
    } finally {
      setBundleReportRowsBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(209,228,255,0.95),_rgba(246,250,254,0.98)_38%,_#edf3f7_100%)] pb-24 font-sans text-[#171c1f] md:pb-8">
      <UpdateBanner
        state={updateBanner}
        onDismiss={() => setUpdateBanner('hidden')}
        onRefresh={() => window.location.reload()}
      />
      <header className="fixed top-0 z-50 flex min-h-[7rem] w-full items-center justify-between border-b border-white/60 bg-[#f6fafe]/80 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex items-start gap-3">
          <InventoryIcon className="mt-0.5 h-6 w-6 text-[#002542]" />
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-[#002542] md:text-xl">KRS Master</h1>
            <div className="mt-1 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[10px] text-[#5b6670] sm:gap-2">
              {stats.map((item) => <span key={item.label} className="rounded-full bg-white/90 px-2 py-0.5 shadow-[0_4px_16px_rgba(0,37,66,0.06)]">{item.label} <b className="text-[#002542]">{item.value}</b></span>)}
            </div>
            <StorageBanner status={storageStatus} message={storageMessage} />
          </div>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          {navItems.map((item) => <button key={item.id} onClick={() => setView(item.id)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${view === item.id ? 'bg-[#d1e4ff] text-[#002542]' : 'text-[#43474d]'}`}>{item.label}</button>)}
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-6 pt-36 xl:grid-cols-[minmax(0,1.3fr)_24rem]">
        <div className="space-y-6">
          {view === 'scanner' && <ScannerPanel videoRef={videoRef} scannerEnabled={scannerEnabled} onToggleScanner={toggleScannerEnabled} scanInput={scanInput} setScanInput={setScanInput} lastScanRaw={lastScanRaw} scanStatus={scanStatus} scanFeedback={scanFeedback} scanError={scanError} onClear={() => { clearScanFeedbackTimeout(); setScanInput(''); setLastScanRaw(''); setScanFeedback(scannerEnabled ? 'scanning' : 'idle'); }} />}
          {view === 'search' && <SearchPanel query={query} setQuery={setQuery} onSearch={runSearch} onClear={() => { setQuery(''); setSubmittedQuery(''); }} validationMessage={searchValidation.message} searchEnabled={searchValidation.canSearch} />}
          {view === 'import' && <ImportPanel inputRef={inputRef} uploading={uploading} uploadMessage={uploadMessage} onChoose={() => inputRef.current?.click()} onFile={async (event) => { const file = event.target.files?.[0]; if (!file) return; await saveMasterFile(file); event.target.value = ''; }} />}
          {view === 'bundle' && <BundlePanel bundleTab={bundleTab} setBundleTab={setBundleTab} onOpenReportStatus={() => void openBundleReportStatus()} bundleForm={bundleForm} setBundleForm={setBundleForm} bundleReportBusy={bundleReportBusy} bundleReportMessage={bundleReportMessage} onSave={saveBundleReport} onDownload={downloadBundleDb} bundleReportRows={bundleReportRows} bundleReportRowsBusy={bundleReportRowsBusy} bundleReportRowsMessage={bundleReportRowsMessage} editingReportId={editingReportId} editingReportForm={editingReportForm} setEditingReportForm={setEditingReportForm} onRefreshReportRows={() => void loadBundleReportRows()} onStartEdit={startEditBundleReport} onCancelEdit={cancelEditBundleReport} onSaveEdit={() => void saveEditedBundleReport()} onDelete={(id) => void removeBundleReport(id)} bundleLookupQuery={bundleLookupQuery} setBundleLookupQuery={setBundleLookupQuery} bundleLookupItems={bundleLookupItems} bundleLookupBusy={bundleLookupBusy} bundleLookupMessage={bundleLookupMessage} onLookup={() => void loadBundleLookup(bundleLookupQuery)} />}
          {view === 'convert' && <ConvertPanel inputRef={convertInputRef} busy={convertBusy} message={convertMessage} summary={convertSummary} items={filteredConvertedItems} totalItems={convertedItems.length} warnings={convertWarnings} query={convertQuery} setQuery={setConvertQuery} onChoose={() => convertInputRef.current?.click()} onFile={async (event) => { const file = event.target.files?.[0]; if (!file) return; await convertFileToBarcodeList(file); event.target.value = ''; }} convertSaveName={convertSaveName} setConvertSaveName={setConvertSaveName} convertSavedMeta={convertSavedMeta} fileSavedConvertSets={fileSavedConvertSets} savedConvertBusy={savedConvertBusy} savedConvertSelection={savedConvertSelection.file} savedConvertMessage={savedConvertMessage} onSaveCurrentConvert={() => void saveCurrentConvertResult('file')} onLoadSavedConvert={(id) => void loadSavedConvertResult('file', id)} onDeleteSavedConvert={() => void removeSavedConvertResult('file')} photoInputRef={photoInputRef} photoGalleryInputRef={photoGalleryInputRef} photoBusy={photoBusy} photoMessage={photoMessage} photoSummary={photoSummary} photoRows={photoRows} photoWarnings={photoWarnings} photoServerSaveName={photoServerSaveName} setPhotoServerSaveName={setPhotoServerSaveName} photoSavedMeta={photoSavedMeta} photoSavedConvertSets={photoSavedConvertSets} photoSavedConvertSelection={savedConvertSelection.photo} onChoosePhoto={() => photoInputRef.current?.click()} onChoosePhotoFromLibrary={() => photoGalleryInputRef.current?.click()} onPhotoFile={async (event) => { const file = event.target.files?.[0]; if (!file) return; await convertInventoryPhoto(file); event.target.value = ''; }} onChangePhotoRow={updatePhotoRow} onDownloadPhotoRows={downloadPhotoRowsAsExcel} onSavePhotoRows={savePhotoRowsToDevice} onSavePhotoRowsToServer={() => void saveCurrentConvertResult('photo')} onLoadSavedPhotoConvert={(id) => void loadSavedConvertResult('photo', id)} onDeleteSavedPhotoConvert={() => void removeSavedConvertResult('photo')} onClearPhotoRows={clearSavedPhotoRows} photoSaveBusy={photoSaveBusy} photoProgress={photoProgress} photoPreviewUrl={photoPreviewUrl} photoPreviewName={photoPreviewName} photoPreviewMeta={photoPreviewMeta} masterRecordByBarcode={masterRecordByBarcode} />}
          {(view === 'scanner' || view === 'search') && <MatchSection exactMatch={exactMatch} similarMatches={similarMatches} emptyMessage={searchEmptyMessage} />}
        </div>
        {view === 'import' && <aside className="space-y-6">
          <Panel title="현재 마스터" icon={<InventoryIcon className="h-5 w-5" />}>
            {summary ? <><MetricRow label="파일명" value={summary.fileName} /><MetricRow label="레코드" value={`${summary.recordCount.toLocaleString()}건`} /><MetricRow label="예외 행" value={`${summary.irregularRows.toLocaleString()}건`} /><MetricRow label="업로드 시각" value={formatDate(summary.importedAt)} /><div className="mt-4 flex flex-wrap gap-3"><button onClick={() => setView('import')} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">마스터 업로드</button><button onClick={clearLocalMaster} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542]">로컬 저장 삭제</button></div></> : <p className="text-sm text-[#5b6670]">업로드된 마스터가 없습니다.</p>}
          </Panel>
          <Panel title="번들 마스터" icon={<BundleIcon className="h-5 w-5" />}>
            <input ref={bundleMasterInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; await uploadBundleMasterFile(file); event.target.value = ''; }} />
            {bundleMasterSummary ? <><MetricRow label="파일명" value={bundleMasterSummary.fileName} /><MetricRow label="레코드" value={`${bundleMasterSummary.recordCount.toLocaleString()}건`} /><MetricRow label="업로드 시각" value={formatDate(bundleMasterSummary.importedAt)} /><div className="mt-4"><button onClick={() => bundleMasterInputRef.current?.click()} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">번들 마스터 업로드</button></div></> : <><p className="text-sm text-[#5b6670]">번들 마스터가 아직 없습니다.</p><div className="mt-4"><button onClick={() => bundleMasterInputRef.current?.click()} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">번들 마스터 업로드</button></div></>}
            {bundleMasterMessage && <p className="mt-4 whitespace-pre-line text-sm text-[#5b6670]">{bundleMasterMessage}</p>}
          </Panel>
          <Panel title="변환 현황" icon={<DescriptionIcon className="h-5 w-5" />}>
            {convertSummary ? <><MetricRow label="파일명" value={convertSummary.fileName} />{convertSummary.savedName ? <MetricRow label="저장 이름" value={convertSummary.savedName} /> : null}<MetricRow label="변환 건수" value={`${convertSummary.recordCount.toLocaleString()}건`} /><MetricRow label="제외 행" value={`${convertSummary.skippedRows.toLocaleString()}건`} /><MetricRow label="변환 시각" value={formatDate(convertSummary.importedAt)} /></> : <p className="text-sm text-[#5b6670]">아직 변환한 파일이 없습니다.</p>}
          </Panel>
          <Panel title="최근 업로드" icon={<HistoryIcon className="h-5 w-5" />}>
            {history.length === 0 ? <p className="text-sm text-[#5b6670]">업로드 기록이 없습니다.</p> : history.map((item) => <div key={item.id}><ImportHistory item={item} /></div>)}
          </Panel>
        </aside>}
      </main>
      <nav className="fixed bottom-0 left-0 z-50 flex h-20 w-full items-center justify-around border-t border-[#dfe3e7] bg-white/95 px-4 shadow-[0_-4px_20px_rgba(0,37,66,0.06)] md:hidden">
        {navItems.map((item) => <button key={item.id} onClick={() => setView(item.id)}><NavItem icon={item.icon} label={item.label} active={view === item.id} /></button>)}
      </nav>
    </div>
  );
}

function ImportPanel({ inputRef, uploading, uploadMessage, onChoose, onFile }: { inputRef: React.RefObject<HTMLInputElement | null>; uploading: boolean; uploadMessage: string | null; onChoose: () => void; onFile: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void> }) {
  return <Panel title="상품 마스터 업로드" icon={<UploadIcon className="h-5 w-5" />}><input ref={inputRef} type="file" accept=".txt,.dat,.mst,.csv,text/plain,text/csv" className="hidden" onChange={onFile} /><button onClick={onChoose} className="flex min-h-[260px] w-full flex-col items-center justify-center rounded-[2rem] border-2 border-dashed border-[#9eb3c7] bg-[#f0f4f8] p-8"><UploadIcon className="mb-5 h-10 w-10 text-[#002542]" /><p className="text-xl font-bold">파일 선택</p><p className="mt-2 text-sm text-[#5b6670]">서버 DB와 브라우저 저장소를 함께 갱신합니다.</p></button>{(uploading || uploadMessage) && <div className="mt-5 rounded-[1.5rem] border border-[#efe4c8] bg-[#fffdf8] p-5 text-sm text-[#5b6670]">{uploading ? '파일 처리 중...' : uploadMessage}</div>}</Panel>;
}

function SearchPanel({
  query,
  setQuery,
  onSearch,
  onClear,
  validationMessage,
  searchEnabled,
}: {
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  onSearch: () => void;
  onClear: () => void;
  validationMessage: string | null;
  searchEnabled: boolean;
}) {
  return (
    <Panel title="바코드 검색" icon={<SearchIcon className="h-5 w-5" />}>
      <div className="flex flex-col gap-3 md:flex-row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && searchEnabled) onSearch();
          }}
          placeholder="바코드, 상품명, 축약명 검색"
          className="flex-1 rounded-2xl border border-[#d6e0ea] bg-white px-5 py-4 outline-none"
        />
        <button
          onClick={onSearch}
          disabled={!searchEnabled}
          className="rounded-2xl bg-[#002542] px-5 py-4 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          검색
        </button>
        <button onClick={onClear} className="rounded-2xl bg-[#edf4fb] px-5 py-4 font-semibold text-[#002542]">초기화</button>
      </div>
      {validationMessage && <p className="mt-3 text-sm text-[#8a5100]">{validationMessage}</p>}
    </Panel>
  );
}

function ConvertPanel(props: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  message: string | null;
  summary: ConvertedBarcodeSummary | null;
  items: ConvertedBarcodeItem[];
  totalItems: number;
  warnings: string[];
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  onChoose: () => void;
  onFile: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  convertSaveName: string;
  setConvertSaveName: React.Dispatch<React.SetStateAction<string>>;
  convertSavedMeta: SavedConvertMeta | null;
  fileSavedConvertSets: SavedConvertSetSummary[];
  savedConvertBusy: boolean;
  savedConvertSelection: number | '';
  savedConvertMessage: string | null;
  onSaveCurrentConvert: () => void;
  onLoadSavedConvert: (id: string) => void;
  onDeleteSavedConvert: () => void;
  photoInputRef: React.RefObject<HTMLInputElement | null>;
  photoGalleryInputRef: React.RefObject<HTMLInputElement | null>;
  photoBusy: boolean;
  photoMessage: string | null;
  photoSummary: InventoryPhotoSummary | null;
  photoRows: InventoryPhotoRow[];
  photoWarnings: string[];
  photoServerSaveName: string;
  setPhotoServerSaveName: React.Dispatch<React.SetStateAction<string>>;
  photoSavedMeta: SavedConvertMeta | null;
  photoSavedConvertSets: SavedConvertSetSummary[];
  photoSavedConvertSelection: number | '';
  onChoosePhoto: () => void;
  onChoosePhotoFromLibrary: () => void;
  onPhotoFile: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onChangePhotoRow: (index: number, key: 'barcode' | 'name', value: string) => void;
  onDownloadPhotoRows: () => void;
  onSavePhotoRows: () => void;
  onSavePhotoRowsToServer: () => void;
  onLoadSavedPhotoConvert: (id: string) => void;
  onDeleteSavedPhotoConvert: () => void;
  onClearPhotoRows: () => void;
  photoSaveBusy: boolean;
  photoProgress: number;
  photoPreviewUrl: string | null;
  photoPreviewName: string | null;
  photoPreviewMeta: string | null;
  masterRecordByBarcode: Map<string, MasterRecord>;
}) {
  const photoProgressLabel = props.photoProgress < 25
    ? '이미지 업로드 중'
    : props.photoProgress < 55
      ? '문서 영역 보정 중'
      : props.photoProgress < 85
        ? 'OCR 분석 중'
        : '결과 정리 중';
  const photoProgressSteps = [
    { label: '파일 확인', done: props.photoProgress >= 8, active: props.photoProgress > 0 && props.photoProgress < 25 },
    { label: '문서 보정', done: props.photoProgress >= 55, active: props.photoProgress >= 25 && props.photoProgress < 55 },
    { label: 'OCR 추출', done: props.photoProgress >= 85, active: props.photoProgress >= 55 && props.photoProgress < 85 },
    { label: '결과 정리', done: props.photoProgress >= 100, active: props.photoProgress >= 85 && props.photoProgress < 100 },
  ];

  return (
    <section className="space-y-6">
      <Panel title="재고현황 표 사진 변환" icon={<DescriptionIcon className="h-5 w-5" />}>
        <input ref={props.photoInputRef} type="file" accept="image/*,application/pdf,.pdf" capture="environment" className="hidden" onChange={props.onPhotoFile} />
        <input ref={props.photoGalleryInputRef} type="file" accept="image/*,application/pdf,.pdf" className="hidden" onChange={props.onPhotoFile} />
        <div className="flex flex-col gap-4 rounded-[2rem] border border-dashed border-[#9eb3c7] bg-[#f0f4f8] p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-lg font-bold text-[#171c1f]">휴대폰 카메라로 재고현황 표 추출</p>
              <p className="mt-2 text-sm text-[#5b6670]">사진, 저장된 이미지, 스캔 PDF를 올려 상품코드 / 상품명 2열을 추출합니다.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={props.onChoosePhoto} disabled={props.photoBusy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">카메라 촬영</button>
              <button onClick={props.onChoosePhotoFromLibrary} disabled={props.photoBusy} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542] disabled:opacity-60">기존 사진 선택</button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 text-sm text-[#5b6670] md:grid-cols-2">
            <div className="rounded-[1.25rem] bg-white px-4 py-3">문서 영역 자동 보정 후 OCR</div>
            <div className="rounded-[1.25rem] bg-white px-4 py-3">촬영 사진, 저장 사진, PDF 업로드 가능</div>
            <div className="rounded-[1.25rem] bg-white px-4 py-3 md:col-span-2">추출 결과는 셀 단위로 수정 가능</div>
          </div>
        </div>
        {props.photoBusy && (
          <div className="mt-4 rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="font-semibold text-[#002542]">{photoProgressLabel}</span>
              <span className="text-[#5b6670]">{Math.min(props.photoProgress, 99)}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-[#dce6f0]">
              <div className="h-full rounded-full bg-[#174f83] transition-[width] duration-300" style={{ width: `${Math.min(props.photoProgress, 99)}%` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {photoProgressSteps.map((step) => (
                <span
                  key={step.label}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    step.done
                      ? 'bg-[#dff3e3] text-[#005c29]'
                      : step.active
                        ? 'bg-[#d1e4ff] text-[#002542]'
                        : 'bg-white text-[#5b6670]'
                  }`}
                >
                  {step.label}
                </span>
              ))}
            </div>
          </div>
        )}
        {props.photoMessage && !props.photoBusy && <div className="mt-4 rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-4 text-sm text-[#5b6670]">{props.photoMessage}</div>}
        {props.photoSummary && <div className="mt-4 rounded-[1.5rem] bg-[#edf4fb] p-4 text-sm text-[#002542]">{props.photoSummary.savedName ? `${props.photoSummary.savedName} / ` : ''}{props.photoSummary.fileName} / {props.photoSummary.recordCount.toLocaleString()}건 / {formatDate(props.photoSummary.importedAt)}</div>}
        {(props.photoPreviewName || props.photoPreviewUrl) && (
          <div className="mt-4 rounded-[1.5rem] border border-[#dce6f0] bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-[#171c1f]">업로드 확인</p>
              {props.photoPreviewMeta && <span className="rounded-full bg-[#edf4fb] px-3 py-1 text-xs font-semibold text-[#002542]">{props.photoPreviewMeta}</span>}
            </div>
            {props.photoPreviewName && <p className="mb-3 text-sm text-[#5b6670]">{props.photoPreviewName}</p>}
            {props.photoPreviewUrl
              ? <img src={props.photoPreviewUrl} alt={props.photoPreviewName ?? '업로드 이미지'} className="max-h-[24rem] w-full rounded-[1.25rem] border border-[#dce6f0] object-contain" />
              : <div className="rounded-[1.25rem] border border-dashed border-[#d6e0ea] bg-[#f8fbfd] px-4 py-6 text-sm text-[#5b6670]">PDF는 미리보기 대신 바로 서버 OCR로 전달됩니다.</div>}
          </div>
        )}
      </Panel>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel title="사진 OCR 추출 결과" icon={<CheckCircleIcon className="h-5 w-5" />}>
          <div className="flex flex-wrap gap-3">
            <div className="rounded-2xl bg-[#edf4fb] px-4 py-3 text-sm font-semibold text-[#002542]">총 {props.photoRows.length.toLocaleString()}건</div>
            <button onClick={props.onSavePhotoRows} disabled={props.photoSaveBusy || props.photoRows.length === 0} className="rounded-2xl bg-[#174f83] px-5 py-3 font-semibold text-white disabled:opacity-60">임시 저장</button>
            <button onClick={props.onSavePhotoRowsToServer} disabled={props.savedConvertBusy || props.photoRows.length === 0} className="rounded-2xl bg-[#8a5100] px-5 py-3 font-semibold text-white disabled:opacity-60">서버 저장</button>
            <button onClick={props.onClearPhotoRows} disabled={props.photoSaveBusy || props.photoRows.length === 0} className="rounded-2xl bg-[#ffe7e5] px-5 py-3 font-semibold text-[#93000a] disabled:opacity-60">임시 저장 삭제</button>
            <button onClick={props.onDownloadPhotoRows} disabled={props.photoRows.length === 0} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">엑셀 다운로드</button>
          </div>
          <div className="mt-4 space-y-3 rounded-[1.5rem] border border-[#f2d4ad] bg-[#fff7ed] p-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <input value={props.photoServerSaveName} onChange={(event) => props.setPhotoServerSaveName(event.target.value)} placeholder="사진 OCR 저장 이름" className="flex-1 rounded-2xl border border-[#efc58f] bg-white px-4 py-3 outline-none" />
              <select value={props.photoSavedConvertSelection} onChange={(event) => props.onLoadSavedPhotoConvert(event.target.value)} className="min-w-[14rem] rounded-2xl border border-[#efc58f] bg-white px-4 py-3 outline-none">
                <option value="">저장본 선택</option>
                {props.photoSavedConvertSets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.recordCount}건</option>)}
              </select>
              <button onClick={props.onDeleteSavedPhotoConvert} disabled={props.savedConvertBusy || !props.photoSavedConvertSelection} className="rounded-2xl bg-[#ffe7e5] px-4 py-3 font-semibold text-[#93000a] disabled:opacity-60">서버 삭제</button>
            </div>
            {props.photoSavedMeta && <p className="text-sm text-[#8a5100]">현재 서버 저장본: {props.photoSavedMeta.savedName} / {formatDate(props.photoSavedMeta.updatedAt)}</p>}
            {props.savedConvertMessage && <p className="text-sm text-[#8a5100]">{props.savedConvertMessage}</p>}
          </div>
          <div className="mt-6 space-y-4">
            {props.photoRows.length === 0 && !props.photoBusy && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">아직 추출된 표가 없습니다.</div>}
            {props.photoRows.map((row, index) => (
              <div key={`photo-row-${row.rowNumber}-${index}`}>
                <PhotoOcrCard
                  row={row}
                  masterName={props.masterRecordByBarcode.get(row.barcode)?.name ?? null}
                  onChangeBarcode={(value) => props.onChangePhotoRow(index, 'barcode', value)}
                  onChangeName={(value) => props.onChangePhotoRow(index, 'name', value)}
                />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="사진 변환 기준" icon={<InfoIcon className="h-5 w-5" />}>
          <MetricRow label="입력 방식" value="이미지 업로드 / 모바일 촬영 / PDF" />
          <MetricRow label="OCR 언어" value="한국어 + 영문" />
          <MetricRow label="추출 열" value="상품코드 / 상품명" />
          <MetricRow label="다운로드" value="날짜 기반 xlsx" />
          {props.photoWarnings.length > 0 && <p className="mt-4 whitespace-pre-line text-sm text-[#8a5100]">{props.photoWarnings.slice(0, 10).join('\n')}{props.photoWarnings.length > 10 ? `\n외 ${props.photoWarnings.length - 10}건` : ''}</p>}
        </Panel>
      </section>

      <Panel title="바코드 변환" icon={<DescriptionIcon className="h-5 w-5" />}>
        <input ref={props.inputRef} type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={props.onFile} />
        <div className="flex flex-col gap-4 rounded-[2rem] border border-dashed border-[#9eb3c7] bg-[#f0f4f8] p-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-lg font-bold text-[#171c1f]">엑셀 / CSV를 바코드 리스트로 변환</p>
            <p className="mt-2 text-sm text-[#5b6670]">헤더는 상품코드, 상품명 형식으로 올려 주세요.</p>
          </div>
          <button onClick={props.onChoose} disabled={props.busy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">파일 선택</button>
        </div>
        {props.message && <div className="mt-4 rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-4 text-sm text-[#5b6670]">{props.busy ? '파일 변환 중...' : props.message}</div>}
      </Panel>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel title="변환 결과" icon={<CheckCircleIcon className="h-5 w-5" />}>
          <div className="mb-4 space-y-3 rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <input value={props.convertSaveName} onChange={(event) => props.setConvertSaveName(event.target.value)} placeholder="변환 결과 저장 이름" className="flex-1 rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
              <button onClick={props.onSaveCurrentConvert} disabled={props.savedConvertBusy || props.totalItems === 0} className="rounded-2xl bg-[#8a5100] px-5 py-3 font-semibold text-white disabled:opacity-60">서버 저장</button>
            </div>
            <div className="flex flex-col gap-3 md:flex-row">
              <select value={props.savedConvertSelection} onChange={(event) => props.onLoadSavedConvert(event.target.value)} className="flex-1 rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none">
                <option value="">저장본 선택</option>
                {props.fileSavedConvertSets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.recordCount}건</option>)}
              </select>
              <button onClick={props.onDeleteSavedConvert} disabled={props.savedConvertBusy || !props.savedConvertSelection} className="rounded-2xl bg-[#ffe7e5] px-4 py-3 font-semibold text-[#93000a] disabled:opacity-60">서버 삭제</button>
            </div>
            {props.convertSavedMeta && <p className="text-sm text-[#5b6670]">현재 서버 저장본: {props.convertSavedMeta.savedName} / {formatDate(props.convertSavedMeta.updatedAt)}</p>}
            {props.savedConvertMessage && <p className="text-sm text-[#5b6670]">{props.savedConvertMessage}</p>}
          </div>
          <input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="상품명 또는 바코드 필터" className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-5 py-4 outline-none" />
          {props.summary && <p className="mt-4 text-sm text-[#5b6670]">{props.summary.savedName ? `${props.summary.savedName} / ` : ''}{props.summary.fileName} / {props.items.length.toLocaleString()}건 표시 중 / 전체 {props.totalItems.toLocaleString()}건</p>}
          <div className="mt-6 space-y-4">
            {!props.busy && props.items.length === 0 && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">{props.totalItems === 0 ? '변환된 데이터가 없습니다.' : '필터 결과가 없습니다.'}</div>}
            {props.items.map((item) => <div key={`${item.rowNumber}-${item.barcode}`}><ConvertedBarcodeCard item={item} masterName={props.masterRecordByBarcode.get(item.barcode)?.name ?? null} /></div>)}
          </div>
        </Panel>

        <Panel title="변환 기준" icon={<InfoIcon className="h-5 w-5" />}>
          <MetricRow label="입력 헤더" value="상품코드 / 상품명" />
          <MetricRow label="출력 값" value="바코드 / 상품명" />
          <MetricRow label="지원 형식" value="xlsx, xls, csv" />
          <MetricRow label="제외 기준" value="빈 상품코드 또는 상품명" />
          {props.warnings.length > 0 && <p className="mt-4 whitespace-pre-line text-sm text-[#8a5100]">{props.warnings.slice(0, 10).join('\n')}{props.warnings.length > 10 ? `\n외 ${props.warnings.length - 10}건` : ''}</p>}
        </Panel>
      </section>
    </section>
  );
}

function ScannerPanel(props: { videoRef: React.RefObject<HTMLVideoElement | null>; scannerEnabled: boolean; onToggleScanner: () => void; scanInput: string; setScanInput: React.Dispatch<React.SetStateAction<string>>; lastScanRaw: string; scanStatus: ScanStatus; scanFeedback: ScanFeedback; scanError: string | null; onClear: () => void }) {
  const overlayTone = props.scanFeedback === 'success' ? 'bg-[#1d6f42]/88 text-white' : 'bg-[#002542]/78 text-white';
  const overlayLabel = props.scanFeedback === 'success' ? '스캔성공' : '스캔중';
  return <Panel title="QR / 바코드 스캐너" icon={<ScannerIcon className="h-5 w-5" />}><div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_16rem]"><div className="space-y-4"><div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] border border-[#153049] bg-[#07131d]"><video ref={props.videoRef} className="h-full w-full object-cover" muted playsInline />{props.scannerEnabled && props.scanStatus === 'active' && <div className={`absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-bold shadow-[0_10px_24px_rgba(0,0,0,0.25)] ${overlayTone}`}>{overlayLabel}</div>}{!props.scannerEnabled && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">카메라를 켜면 스캔을 시작합니다.</div>}</div><div className="flex flex-wrap gap-3"><button onClick={props.onToggleScanner} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">{props.scannerEnabled ? '카메라 끄기' : '카메라 활성화'}</button><button onClick={props.onClear} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542]">재스캔</button></div></div><ScannerSummaryCard scanStatus={props.scanStatus} scanFeedback={props.scanFeedback} scanError={props.scanError} lastScanRaw={props.lastScanRaw} /></div></Panel>;
}

function BundlePanel(props: {
  bundleTab: BundleTab;
  setBundleTab: React.Dispatch<React.SetStateAction<BundleTab>>;
  onOpenReportStatus: () => void;
  bundleForm: BundleReportInput;
  setBundleForm: React.Dispatch<React.SetStateAction<BundleReportInput>>;
  bundleReportBusy: boolean;
  bundleReportMessage: string | null;
  onSave: () => void;
  onDownload: () => void;
  bundleReportRows: BundleReportRow[];
  bundleReportRowsBusy: boolean;
  bundleReportRowsMessage: string | null;
  editingReportId: number | null;
  editingReportForm: BundleReportInput;
  setEditingReportForm: React.Dispatch<React.SetStateAction<BundleReportInput>>;
  onRefreshReportRows: () => void;
  onStartEdit: (row: BundleReportRow) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: (id: number) => void;
  bundleLookupQuery: string;
  setBundleLookupQuery: React.Dispatch<React.SetStateAction<string>>;
  bundleLookupItems: BundleMasterRecord[];
  bundleLookupBusy: boolean;
  bundleLookupMessage: string | null;
  onLookup: () => void;
}) {
  const limitByLength = (setter: React.Dispatch<React.SetStateAction<BundleReportInput>>, key: keyof BundleReportInput, value: string, maxLength: number) => {
    setter((prev) => ({ ...prev, [key]: value.slice(0, maxLength) }));
  };

  const limitByByte = (setter: React.Dispatch<React.SetStateAction<BundleReportInput>>, key: 'bundleName' | 'itemName', value: string, maxBytes: number) => {
    let nextValue = '';
    for (const char of value) {
      const candidate = `${nextValue}${char}`;
      if (new TextEncoder().encode(candidate).length > maxBytes) break;
      nextValue = candidate;
    }
    setter((prev) => ({ ...prev, [key]: nextValue }));
  };

  return (
    <section className="space-y-6">
      <Panel title="번들 관리" icon={<BundleIcon className="h-5 w-5" />}>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => props.setBundleTab('report')} className={`rounded-full px-4 py-2 text-sm font-semibold ${props.bundleTab === 'report' ? 'bg-[#002542] text-white' : 'bg-[#edf4fb] text-[#002542]'}`}>번들 제보</button>
          <button onClick={props.onOpenReportStatus} className={`rounded-full px-4 py-2 text-sm font-semibold ${props.bundleTab === 'reportStatus' ? 'bg-[#002542] text-white' : 'bg-[#edf4fb] text-[#002542]'}`}>번들 제보 상황</button>
          <button onClick={() => props.setBundleTab('lookup')} className={`rounded-full px-4 py-2 text-sm font-semibold ${props.bundleTab === 'lookup' ? 'bg-[#002542] text-white' : 'bg-[#edf4fb] text-[#002542]'}`}>번들 검색</button>
        </div>
      </Panel>

      {props.bundleTab === 'report' && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel title="번들 제보" icon={<InfoIcon className="h-5 w-5" />}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <BundleField label="상품명">
                <input value={props.bundleForm.bundleName} onChange={(event) => limitByByte(props.setBundleForm, 'bundleName', event.target.value, 30)} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
              </BundleField>
              <BundleField label="번들 바코드">
                <input value={props.bundleForm.bundleBarcode} onChange={(event) => limitByLength(props.setBundleForm, 'bundleBarcode', event.target.value.replace(/\D/g, ''), 13)} maxLength={13} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
              </BundleField>
              <BundleField label="입수">
                <input value={props.bundleForm.quantity} onChange={(event) => limitByLength(props.setBundleForm, 'quantity', event.target.value.replace(/\D/g, ''), 2)} maxLength={2} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
              </BundleField>
              <BundleField label="낱개 바코드">
                <input value={props.bundleForm.itemBarcode} onChange={(event) => limitByLength(props.setBundleForm, 'itemBarcode', event.target.value.replace(/\D/g, ''), 13)} maxLength={13} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
              </BundleField>
              <div className="md:col-span-2">
                <BundleField label="낱개 상품명">
                  <input value={props.bundleForm.itemName} onChange={(event) => limitByByte(props.setBundleForm, 'itemName', event.target.value, 30)} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
                </BundleField>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <button onClick={props.onSave} disabled={props.bundleReportBusy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">저장</button>
              <button onClick={props.onDownload} disabled={props.bundleReportBusy} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542] disabled:opacity-60">DB 다운로드</button>
            </div>
            {props.bundleReportMessage && <p className="mt-4 whitespace-pre-line text-sm text-[#5b6670]">{props.bundleReportMessage}</p>}
          </Panel>
          <Panel title="입력 기준" icon={<InfoIcon className="h-5 w-5" />}>
            <MetricRow label="상품명" value={`${new TextEncoder().encode(props.bundleForm.bundleName).length} / 30byte`} />
            <MetricRow label="번들 바코드" value={`${props.bundleForm.bundleBarcode.length} / 13`} />
            <MetricRow label="입수" value={`${props.bundleForm.quantity.length} / 2`} />
            <MetricRow label="낱개 바코드" value={`${props.bundleForm.itemBarcode.length} / 13`} />
          </Panel>
        </section>
      )}

      {props.bundleTab === 'reportStatus' && (
        <section className="space-y-6">
          <Panel title="번들 제보 상황" icon={<HistoryIcon className="h-5 w-5" />}>
            <div className="flex flex-wrap gap-3">
              <button onClick={props.onRefreshReportRows} disabled={props.bundleReportRowsBusy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">새로고침</button>
              <button onClick={props.onDownload} disabled={props.bundleReportRowsBusy} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542] disabled:opacity-60">DB 다운로드</button>
            </div>
            {props.bundleReportRowsMessage && <p className="mt-4 text-sm text-[#5b6670]">{props.bundleReportRowsMessage}</p>}
            <div className="mt-6 space-y-4">
              {props.bundleReportRowsBusy && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">번들 제보 상황을 불러오는 중입니다.</div>}
              {props.bundleReportRows.map((row) => (
                <div key={row.id}>
                  <BundleReportStatusCard
                    row={row}
                    isEditing={props.editingReportId === row.id}
                    editingForm={props.editingReportForm}
                    setEditingForm={props.setEditingReportForm}
                    busy={props.bundleReportRowsBusy}
                    onStartEdit={() => props.onStartEdit(row)}
                    onCancelEdit={props.onCancelEdit}
                    onSaveEdit={props.onSaveEdit}
                    onDelete={() => props.onDelete(row.id)}
                    limitByLength={limitByLength}
                    limitByByte={limitByByte}
                  />
                </div>
              ))}
              {!props.bundleReportRowsBusy && props.bundleReportRows.length === 0 && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">저장된 번들 제보가 없습니다.</div>}
            </div>
          </Panel>
        </section>
      )}

      {props.bundleTab === 'lookup' && (
        <section className="space-y-6">
          <Panel title="번들 검색" icon={<SearchIcon className="h-5 w-5" />}>
            <div className="flex flex-col gap-3 md:flex-row">
              <input value={props.bundleLookupQuery} onChange={(event) => props.setBundleLookupQuery(event.target.value)} placeholder="상품명 또는 바코드 검색" className="flex-1 rounded-2xl border border-[#d6e0ea] bg-white px-5 py-4 outline-none" />
              <button onClick={props.onLookup} disabled={props.bundleLookupBusy || !props.bundleLookupQuery.trim()} className="rounded-2xl bg-[#002542] px-5 py-4 font-semibold text-white disabled:opacity-60">검색</button>
            </div>
            {props.bundleLookupMessage && <p className="mt-4 text-sm text-[#5b6670]">{props.bundleLookupMessage}</p>}
            <div className="mt-6 space-y-4">
              {props.bundleLookupItems.map((item) => <div key={`${item.rowNumber}-${item.bundleBarcode}-${item.itemBarcode}`}><BundleCard item={item} /></div>)}
              {!props.bundleLookupBusy && props.bundleLookupItems.length === 0 && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">검색 결과가 없습니다.</div>}
            </div>
          </Panel>
        </section>
      )}
    </section>
  );
}

function MatchSection({ exactMatch, similarMatches, emptyMessage }: { exactMatch?: BarcodeMatch; similarMatches: BarcodeMatch[]; emptyMessage: string }) {
  if (!exactMatch && similarMatches.length === 0) return <Panel title="매칭 결과" icon={<SearchIcon className="h-5 w-5" />}><p className="text-sm text-[#5b6670]">{emptyMessage}</p></Panel>;
  return <section className="space-y-6">{exactMatch && <Panel title="완전 일치" icon={<CheckCircleIcon className="h-5 w-5" />}><MatchCard match={exactMatch} emphasize /></Panel>}<Panel title="유사 후보" icon={<SearchIcon className="h-5 w-5" />}><div className="space-y-4">{similarMatches.map((match) => <div key={`${match.record.barcode}-${match.record.lineNumber}`}><MatchCard match={match} /></div>)}</div></Panel></section>;
}

function MatchCard({ match, emphasize = false }: { match: BarcodeMatch; emphasize?: boolean }) {
  const isBundle = match.record.shortName.trim() === '';
  const cardTone = isBundle
    ? 'border-[#efc58f] bg-[#fff4e6]'
    : emphasize
      ? 'border-[#b6e1bd] bg-[#eef8ee]'
      : 'border-[#dce6f0] bg-[#f8fbfd]';
  const statusTone = isBundle
    ? 'bg-[#ffe1bf] text-[#8a5100]'
    : emphasize
      ? 'bg-[#dff3e3] text-[#005c29]'
      : 'bg-[#e7f0fb] text-[#174f83]';
  const reasonTone = isBundle
    ? 'border-[#f1d4aa] bg-white text-[#8a5100]'
    : 'border-[#dce6f0] bg-white text-[#5b6670]';

  return <div className={`rounded-[1.75rem] border p-5 ${cardTone}`}><div className="flex flex-col gap-4 md:flex-row md:justify-between"><div><p className="font-mono text-lg font-bold text-[#002542]">{match.record.barcode}</p><p className="mt-2 text-lg font-bold text-[#171c1f]">{match.record.name || '-'}</p><p className="mt-1 text-sm text-[#5b6670]">축약명 {match.record.shortName || '-'}</p></div><div className="flex flex-col items-start gap-2 md:items-end"><div className="flex flex-wrap gap-2 md:justify-end"><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusTone}`}>{match.matchType === 'exact' ? 'EXACT' : match.matchType.toUpperCase()}</span>{isBundle && <span className="rounded-full bg-[#ffb86b] px-3 py-1 text-xs font-bold text-[#6a3900]">번들</span>}</div><span className="text-sm text-[#5b6670]">유사도 {formatSimilarity(match.score)}</span></div></div>{match.reasons.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{match.reasons.map((reason) => <span key={reason} className={`rounded-full border px-3 py-1 text-xs ${reasonTone}`}>{reason}</span>)}</div>}<div className="mt-4"><BarcodePreview value={match.record.barcode} /></div></div>;
}

function BundleCard({ item }: { item: BundleMasterRecord }) {
  return <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-lg font-bold text-[#171c1f]">{item.bundleName}</p><p className="mt-1 font-mono text-sm text-[#002542]">번들 {item.bundleBarcode}</p></div><span className="rounded-full bg-[#d1e4ff] px-3 py-1 text-xs font-bold text-[#002542]">입수 {item.quantity}</span></div><div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"><InfoBox label="낱개 바코드" value={item.itemBarcode} mono /><InfoBox label="낱개 상품명" value={item.itemName} /></div></div>;
}

function ConvertedBarcodeCard({ item, masterName }: { item: ConvertedBarcodeItem; masterName: string | null }) {
  return <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-lg font-bold text-[#002542]">{item.barcode}</p><div className="mt-2 flex flex-wrap items-center gap-2"><span className={`rounded-full px-3 py-1 text-xs font-bold ${masterName ? 'bg-[#dff3e3] text-[#005c29]' : 'bg-[#ffe7e5] text-[#93000a]'}`}>{masterName ? '마스터 일치' : '마스터 불일치'}</span>{masterName && <span className="text-sm text-[#5b6670]">마스터명 {masterName}</span>}</div><p className="mt-3 text-lg font-bold text-[#171c1f]">{item.name}</p></div><span className="rounded-full bg-[#edf4fb] px-3 py-1 text-xs font-bold text-[#002542]">{item.rowNumber}행</span></div><div className="mt-4"><BarcodePreview value={item.barcode} /></div></div>;
}

function PhotoOcrCard(props: {
  row: InventoryPhotoRow;
  masterName: string | null;
  onChangeBarcode: (value: string) => void;
  onChangeName: (value: string) => void;
}) {
  return (
    <div className="rounded-[1.5rem] border border-[#dce6f0] bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[#5b6670]">{props.row.rowNumber}행</p>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${props.masterName ? 'bg-[#dff3e3] text-[#005c29]' : 'bg-[#ffe7e5] text-[#93000a]'}`}>{props.masterName ? '마스터 일치' : '마스터 불일치'}</span>
      </div>
      <div className="mt-4">
        <BundleField label="상품코드">
          <input value={props.row.barcode} onChange={(event) => props.onChangeBarcode(event.target.value.replace(/\D/g, ''))} inputMode="numeric" className="w-full rounded-xl border border-[#d6e0ea] bg-white px-3 py-2 font-mono outline-none" />
        </BundleField>
      </div>
      <div className="mt-4">
        <BundleField label="상품명">
          <input value={props.row.name} onChange={(event) => props.onChangeName(event.target.value)} className="w-full rounded-xl border border-[#d6e0ea] bg-white px-3 py-2 outline-none" />
        </BundleField>
      </div>
      <div className="mt-4">
        <BundleField label="생성 바코드">
          <BarcodePreview value={props.row.barcode} />
        </BundleField>
      </div>
      {props.masterName && <p className="mt-3 text-sm text-[#005c29]">마스터 상품명: {props.masterName}</p>}
    </div>
  );
}

function BundleReportStatusCard(props: {
  row: BundleReportRow;
  isEditing: boolean;
  editingForm: BundleReportInput;
  setEditingForm: React.Dispatch<React.SetStateAction<BundleReportInput>>;
  busy: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
  limitByLength: (setter: React.Dispatch<React.SetStateAction<BundleReportInput>>, key: keyof BundleReportInput, value: string, maxLength: number) => void;
  limitByByte: (setter: React.Dispatch<React.SetStateAction<BundleReportInput>>, key: 'bundleName' | 'itemName', value: string, maxBytes: number) => void;
}) {
  if (props.isEditing) {
    return (
      <div className="rounded-[1.5rem] border border-[#d6e0ea] bg-[#fffdf8] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-lg font-bold text-[#171c1f]">제보 #{props.row.id} 수정</p>
          <span className="text-xs text-[#5b6670]">{formatDate(props.row.createdAt)}</span>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BundleField label="상품명">
            <input value={props.editingForm.bundleName} onChange={(event) => props.limitByByte(props.setEditingForm, 'bundleName', event.target.value, 30)} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
          </BundleField>
          <BundleField label="번들 바코드">
            <input value={props.editingForm.bundleBarcode} onChange={(event) => props.limitByLength(props.setEditingForm, 'bundleBarcode', event.target.value.replace(/\D/g, ''), 13)} maxLength={13} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
          </BundleField>
          <BundleField label="입수">
            <input value={props.editingForm.quantity} onChange={(event) => props.limitByLength(props.setEditingForm, 'quantity', event.target.value.replace(/\D/g, ''), 2)} maxLength={2} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
          </BundleField>
          <BundleField label="낱개 바코드">
            <input value={props.editingForm.itemBarcode} onChange={(event) => props.limitByLength(props.setEditingForm, 'itemBarcode', event.target.value.replace(/\D/g, ''), 13)} maxLength={13} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
          </BundleField>
          <div className="md:col-span-2">
            <BundleField label="낱개 상품명">
              <input value={props.editingForm.itemName} onChange={(event) => props.limitByByte(props.setEditingForm, 'itemName', event.target.value, 30)} className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-4 py-3 outline-none" />
            </BundleField>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button onClick={props.onSaveEdit} disabled={props.busy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">업데이트</button>
          <button onClick={props.onCancelEdit} disabled={props.busy} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542] disabled:opacity-60">취소</button>
          <button onClick={props.onDelete} disabled={props.busy} className="rounded-2xl bg-[#ffe7e5] px-5 py-3 font-semibold text-[#93000a] disabled:opacity-60">삭제</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-[#171c1f]">{props.row.bundleName}</p>
          <p className="mt-1 font-mono text-sm text-[#002542]">번들 {props.row.bundleBarcode}</p>
        </div>
        <div className="text-right">
          <span className="rounded-full bg-[#d1e4ff] px-3 py-1 text-xs font-bold text-[#002542]">입수 {props.row.quantity}</span>
          <p className="mt-2 text-xs text-[#5b6670]">{formatDate(props.row.createdAt)}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <InfoBox label="낱개 바코드" value={props.row.itemBarcode} mono />
        <InfoBox label="낱개 상품명" value={props.row.itemName} />
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={props.onStartEdit} disabled={props.busy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">수정</button>
        <button onClick={props.onDelete} disabled={props.busy} className="rounded-2xl bg-[#ffe7e5] px-5 py-3 font-semibold text-[#93000a] disabled:opacity-60">삭제</button>
      </div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-[2rem] bg-white/85 p-6 shadow-[0_10px_40px_rgba(0,37,66,0.07)] backdrop-blur md:p-8"><div className="mb-6 flex items-center gap-3 text-[#002542]">{icon}<h2 className="text-xl font-bold tracking-tight">{title}</h2></div>{children}</section>;
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 border-b border-[#edf2f7] py-3 last:border-b-0"><span className="text-sm text-[#5b6670]">{label}</span><span className="text-right font-semibold text-[#171c1f]">{value}</span></div>;
}

function ScannerSummaryCard({ scanStatus, scanFeedback, scanError, lastScanRaw }: { scanStatus: ScanStatus; scanFeedback: ScanFeedback; scanError: string | null; lastScanRaw: string }) {
  const tone = scanFeedback === 'success'
    ? 'bg-[#e8f7ec] text-[#005c29]'
    : scanStatus === 'active'
      ? 'bg-[#e8f7ec] text-[#005c29]'
      : scanStatus === 'error'
        ? 'bg-[#ffe7e5] text-[#93000a]'
        : scanStatus === 'unsupported' || scanStatus === 'denied'
          ? 'bg-[#fff2dd] text-[#8a5100]'
          : 'bg-[#e7f0fb] text-[#174f83]';
  const label = scanFeedback === 'success'
    ? '스캔 성공'
    : scanStatus === 'starting'
      ? '카메라 시작 중'
      : scanStatus === 'active'
        ? '실시간 스캔 중'
        : scanStatus === 'unsupported'
          ? '브라우저 미지원'
          : scanStatus === 'denied'
            ? '권한 필요'
            : scanStatus === 'error'
            ? '카메라 오류'
              : '대기 중';
  return (
    <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-[#5b6670]">스캐너</span>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${tone}`}>{label}</span>
      </div>
      <div className="mt-3 rounded-2xl bg-white px-3 py-2">
        <p className="text-[11px] font-semibold text-[#7a8791]">최근 스캔</p>
        <p className="mt-1 break-all font-mono text-sm text-[#002542]">{lastScanRaw || '-'}</p>
      </div>
    </div>
  );
}

function InfoBox({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-[1.75rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><p className="text-sm text-[#5b6670]">{label}</p><p className={`mt-2 break-all ${mono ? 'font-mono text-[#002542]' : 'font-semibold text-[#171c1f]'}`}>{value}</p></div>;
}

function BundleField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-semibold text-[#43474d]">{label}</span>{children}</label>;
}

function StorageBanner({ status, message }: { status: StorageStatus; message: string | null }) {
  const tone = status === 'loaded' ? 'border-[#cbe7d2] bg-[#eef8ee] text-[#005c29]' : status === 'saving' ? 'border-[#cfe0f4] bg-[#eef5fd] text-[#174f83]' : status === 'error' ? 'border-[#f1c5c0] bg-[#fff0ee] text-[#93000a]' : 'border-[#dce6f0] bg-white/85 text-[#5b6670]';
  return <div className={`mt-1.5 inline-flex max-w-full rounded-full border px-3 py-1 text-[11px] shadow-[0_4px_16px_rgba(0,37,66,0.04)] ${tone}`}>{message}</div>;
}

function UpdateBanner({ state, onDismiss, onRefresh }: { state: UpdateBannerState; onDismiss: () => void; onRefresh: () => void }) {
  if (state === 'hidden') return null;
  const message = state === 'updateReady'
    ? '새 버전이 준비되었습니다. 작성 중인 입력값은 유지되며 새로고침 후 최신 화면이 적용됩니다.'
    : '이 기기에서 오프라인 준비가 완료되었습니다.';
  return (
    <div className="fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
      <div className="flex w-full max-w-xl items-center justify-between gap-3 rounded-[1.5rem] border border-[#cfe0f4] bg-white/95 px-4 py-3 shadow-[0_18px_40px_rgba(0,37,66,0.14)] backdrop-blur">
        <p className="text-sm text-[#174f83]">{message}</p>
        <div className="flex items-center gap-2">
          {state === 'updateReady' && <button onClick={onRefresh} className="rounded-xl bg-[#002542] px-3 py-2 text-sm font-semibold text-white">지금 반영</button>}
          <button onClick={onDismiss} className="rounded-xl bg-[#edf4fb] px-3 py-2 text-sm font-semibold text-[#002542]">닫기</button>
        </div>
      </div>
    </div>
  );
}

function ImportHistory({ item }: { item: PersistedHistoryItem }) {
  return <div className="mb-4 last:mb-0"><div className="flex items-start justify-between gap-4"><div><h4 className="font-bold text-[#171c1f]">{item.name}</h4><p className="mt-1 text-xs text-[#43474d]">{formatDate(item.importedAt)}</p></div><span className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${item.summary.irregularRows > 0 ? 'bg-[#fff1e5] text-[#8a5100]' : 'bg-[#e8f7ec] text-[#005c29]'}`}>{item.summary.irregularRows > 0 ? '검수 필요' : '정상'}</span></div><div className="mt-2 flex items-center gap-4 text-sm text-[#43474d]"><span>{item.summary.recordCount.toLocaleString()}건</span><span>예외 {item.summary.irregularRows.toLocaleString()}건</span></div></div>;
}

function NavItem({ icon, label, active = false }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return <div className={`flex flex-col items-center justify-center px-3 py-1 ${active ? 'rounded-2xl bg-[#d1e4ff] text-[#002542]' : 'text-[#43474d]'}`}><div className="flex h-6 w-6 items-center justify-center">{icon}</div><span className="mt-1 text-[10px] font-bold tracking-wider">{label}</span></div>;
}

function buildNextHistory(history: PersistedHistoryItem[], fileName: string, summary: MasterFileSummary) {
  return [{ id: createHistoryId(), name: fileName, importedAt: summary.importedAt, summary }, ...history].slice(0, 8);
}

function stopScanner(videoRef: React.RefObject<HTMLVideoElement | null>, rafRef: React.RefObject<number | null>, streamRef: React.RefObject<MediaStream | null>, scanControlsRef: React.RefObject<ScannerControls | null>) {
  if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  if (scanControlsRef.current) { scanControlsRef.current.stop(); scanControlsRef.current = null; }
  if (streamRef.current) { streamRef.current.getTracks().forEach((track) => track.stop()); streamRef.current = null; }
  if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; }
}

function buildScannerVideoConstraints(): MediaTrackConstraints {
  return {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    ...buildScannerFocusConstraints(),
  };
}

function buildScannerFocusConstraints(): MediaTrackConstraints {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
  const advanced: MediaTrackConstraintSet[] = [];
  if ((supported as Record<string, boolean>).focusMode) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
  return advanced.length ? { advanced } : {};
}

async function optimizeScannerTrack(track?: MediaStreamTrack) {
  if (!track || typeof track.applyConstraints !== 'function') return;
  const advanced: MediaTrackConstraintSet[] = [];
  const capabilities = typeof track.getCapabilities === 'function' ? (track.getCapabilities() as Record<string, unknown>) : null;
  if (capabilities && 'focusMode' in capabilities) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
  if (!advanced.length) return;
  try {
    await track.applyConstraints({ advanced });
  } catch {
    // Some mobile browsers reject focus hints even when capability probing succeeds.
  }
}

function validateBundleForm(form: BundleReportInput) {
  if (!form.bundleName.trim()) return '상품명을 입력해 주세요.';
  if (new TextEncoder().encode(form.bundleName.trim()).length > 30) return '상품명은 30byte 이하여야 합니다.';
  if (!/^\d{1,13}$/.test(form.bundleBarcode)) return '번들 바코드는 1~13자리 숫자여야 합니다.';
  if (!/^\d{1,2}$/.test(form.quantity)) return '입수는 1~99 범위로 입력해 주세요.';
  if (!/^\d{1,13}$/.test(form.itemBarcode)) return '낱개 바코드는 1~13자리 숫자여야 합니다.';
  if (!form.itemName.trim()) return '낱개 상품명을 입력해 주세요.';
  if (new TextEncoder().encode(form.itemName.trim()).length > 30) return '낱개 상품명은 30byte 이하여야 합니다.';
  return null;
}

function getSearchValidation(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { canSearch: false, message: '검색어를 입력해 주세요.' };
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed.length >= 4
      ? { canSearch: true, message: null }
      : { canSearch: false, message: '숫자 검색은 최소 4자리부터 가능합니다.' };
  }

  const compact = trimmed.replace(/\s+/g, '');
  const isChosungOnly = /^[ㄱ-ㅎ]+$/.test(compact);
  if (isChosungOnly) {
    return compact.length >= 2
      ? { canSearch: true, message: null }
      : { canSearch: false, message: '초성 검색은 최소 2자부터 가능합니다.' };
  }

  return new TextEncoder().encode(compact).length >= 2
    ? { canSearch: true, message: null }
    : { canSearch: false, message: '한글 또는 영문 검색은 최소 2byte부터 가능합니다.' };
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('ko-KR');
}

function formatNowForFile() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

function buildDefaultSaveName(fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) return `변환결과_${formatNowForFile()}`;
  const dotIndex = trimmed.lastIndexOf('.');
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
}

function createHistoryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mergePhotoRows(previous: InventoryPhotoRow[], incoming: InventoryPhotoRow[]) {
  const merged = [...previous.map((row) => ({ ...row }))];
  for (const item of incoming) {
    merged.push({
      ...item,
      rowNumber: merged.length + 1,
    });
  }
  return merged;
}






import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarcodePreview } from './components/BarcodePreview';
import { BundleIcon, CheckCircleIcon, DescriptionIcon, HistoryIcon, InfoIcon, InventoryIcon, ScannerIcon, SearchIcon, UploadIcon } from './components/Icons';
import {
  createBundleReport,
  deleteBundleReport,
  downloadBundleReportDb,
  fetchBundleMasterStatus,
  fetchServerMaster,
  listBundleReports,
  searchBundleMaster,
  updateBundleReport,
  type BundleMasterRecord,
  type BundleMasterSummary,
  type BundleReportInput,
  type BundleReportRow,
  uploadBundleMaster,
  uploadMasterToServer,
} from './lib/api';
import { parseConversionFile, type ConvertedBarcodeItem, type ConvertedBarcodeSummary } from './lib/converter';
import { clearPersistedState, loadPersistedState, savePersistedState, type PersistedHistoryItem } from './lib/persistence';
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
  const [bundleReportRows, setBundleReportRows] = useState<BundleReportRow[]>([]);
  const [bundleReportRowsBusy, setBundleReportRowsBusy] = useState(false);
  const [bundleReportRowsMessage, setBundleReportRowsMessage] = useState<string | null>(null);
  const [editingReportId, setEditingReportId] = useState<number | null>(null);
  const [editingReportForm, setEditingReportForm] = useState<BundleReportInput>(emptyBundleForm);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const bundleMasterInputRef = useRef<HTMLInputElement | null>(null);
  const convertInputRef = useRef<HTMLInputElement | null>(null);
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
    void load();
    void loadBundle();
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
      await uploadMasterToServer(file);
      const nextHistory = buildNextHistory(history, file.name, parsed.summary);
      await savePersistedState({ records: parsed.records, summary: parsed.summary, history: nextHistory, savedAt: new Date().toISOString() });
      setRecords(parsed.records);
      setSummary(parsed.summary);
      setHistory(nextHistory);
      setStorageStatus('loaded');
      setStorageMessage('서버 마스터 동기화 완료');
      setUploadMessage(`${parsed.summary.recordCount.toLocaleString()}건 업로드 완료`);
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
          {view === 'bundle' && <BundlePanel bundleTab={bundleTab} setBundleTab={setBundleTab} onOpenReportStatus={() => void openBundleReportStatus()} bundleForm={bundleForm} setBundleForm={setBundleForm} bundleReportBusy={bundleReportBusy} bundleReportMessage={bundleReportMessage} onSave={saveBundleReport} onDownload={downloadBundleDb} bundleReportRows={bundleReportRows} bundleReportRowsBusy={bundleReportRowsBusy} bundleReportRowsMessage={bundleReportRowsMessage} editingReportId={editingReportId} editingReportForm={editingReportForm} setEditingReportForm={setEditingReportForm} onRefreshReportRows={() => void loadBundleReportRows()} onStartEdit={startEditBundleReport} onCancelEdit={cancelEditBundleReport} onSaveEdit={() => void saveEditedBundleReport()} onDelete={(id) => void removeBundleReport(id)} bundleMasterInputRef={bundleMasterInputRef} bundleMasterBusy={bundleMasterBusy} bundleMasterMessage={bundleMasterMessage} bundleMasterSummary={bundleMasterSummary} onPickBundleMaster={() => bundleMasterInputRef.current?.click()} onBundleMasterFile={async (event) => { const file = event.target.files?.[0]; if (!file) return; await uploadBundleMasterFile(file); event.target.value = ''; }} bundleLookupQuery={bundleLookupQuery} setBundleLookupQuery={setBundleLookupQuery} bundleLookupItems={bundleLookupItems} bundleLookupBusy={bundleLookupBusy} bundleLookupMessage={bundleLookupMessage} onLookup={() => void loadBundleLookup(bundleLookupQuery)} />}
          {view === 'convert' && <ConvertPanel inputRef={convertInputRef} busy={convertBusy} message={convertMessage} summary={convertSummary} items={filteredConvertedItems} totalItems={convertedItems.length} warnings={convertWarnings} query={convertQuery} setQuery={setConvertQuery} onChoose={() => convertInputRef.current?.click()} onFile={async (event) => { const file = event.target.files?.[0]; if (!file) return; await convertFileToBarcodeList(file); event.target.value = ''; }} />}
          {(view === 'scanner' || view === 'search') && <MatchSection exactMatch={exactMatch} similarMatches={similarMatches} emptyMessage={searchEmptyMessage} />}
        </div>
        <aside className="space-y-6">
          <Panel title="현재 마스터" icon={<InventoryIcon className="h-5 w-5" />}>
            {summary ? <><MetricRow label="파일명" value={summary.fileName} /><MetricRow label="레코드" value={`${summary.recordCount.toLocaleString()}건`} /><MetricRow label="예외 행" value={`${summary.irregularRows.toLocaleString()}건`} /><MetricRow label="업로드 시각" value={formatDate(summary.importedAt)} /><div className="mt-4 flex flex-wrap gap-3"><button onClick={() => setView('import')} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white">마스터 업로드</button><button onClick={clearLocalMaster} className="rounded-2xl bg-[#edf4fb] px-5 py-3 font-semibold text-[#002542]">로컬 저장 삭제</button></div></> : <p className="text-sm text-[#5b6670]">업로드된 마스터가 없습니다.</p>}
          </Panel>
          <Panel title="번들 마스터" icon={<BundleIcon className="h-5 w-5" />}>
            {bundleMasterSummary ? <><MetricRow label="파일명" value={bundleMasterSummary.fileName} /><MetricRow label="레코드" value={`${bundleMasterSummary.recordCount.toLocaleString()}건`} /><MetricRow label="업로드 시각" value={formatDate(bundleMasterSummary.importedAt)} /></> : <p className="text-sm text-[#5b6670]">번들 마스터가 아직 없습니다.</p>}
          </Panel>
          <Panel title="변환 현황" icon={<DescriptionIcon className="h-5 w-5" />}>
            {convertSummary ? <><MetricRow label="파일명" value={convertSummary.fileName} /><MetricRow label="변환 건수" value={`${convertSummary.recordCount.toLocaleString()}건`} /><MetricRow label="제외 행" value={`${convertSummary.skippedRows.toLocaleString()}건`} /><MetricRow label="변환 시각" value={formatDate(convertSummary.importedAt)} /></> : <p className="text-sm text-[#5b6670]">아직 변환한 파일이 없습니다.</p>}
          </Panel>
          <Panel title="최근 업로드" icon={<HistoryIcon className="h-5 w-5" />}>
            {history.length === 0 ? <p className="text-sm text-[#5b6670]">업로드 기록이 없습니다.</p> : history.map((item) => <div key={item.id}><ImportHistory item={item} /></div>)}
          </Panel>
        </aside>
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
}) {
  return (
    <section className="space-y-6">
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
          <input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="상품명 또는 바코드 필터" className="w-full rounded-2xl border border-[#d6e0ea] bg-white px-5 py-4 outline-none" />
          {props.summary && <p className="mt-4 text-sm text-[#5b6670]">{props.summary.fileName} / {props.items.length.toLocaleString()}건 표시 중 / 전체 {props.totalItems.toLocaleString()}건</p>}
          <div className="mt-6 space-y-4">
            {!props.busy && props.items.length === 0 && <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5 text-sm text-[#5b6670]">{props.totalItems === 0 ? '변환된 데이터가 없습니다.' : '필터 결과가 없습니다.'}</div>}
            {props.items.map((item) => <div key={`${item.rowNumber}-${item.barcode}`}><ConvertedBarcodeCard item={item} /></div>)}
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
  bundleMasterInputRef: React.RefObject<HTMLInputElement | null>;
  bundleMasterBusy: boolean;
  bundleMasterMessage: string | null;
  bundleMasterSummary: BundleMasterSummary | null;
  onPickBundleMaster: () => void;
  onBundleMasterFile: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
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
          <Panel title="번들 마스터 업로드" icon={<UploadIcon className="h-5 w-5" />}>
            <input ref={props.bundleMasterInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={props.onBundleMasterFile} />
            <div className="flex flex-col gap-4 rounded-[2rem] border border-[#dce6f0] bg-[#f8fbfd] p-6 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-lg font-bold text-[#171c1f]">번들 마스터 엑셀 업로드</p>
                <p className="mt-2 text-sm text-[#5b6670]">업로드 시 기존 번들 마스터 DB는 새 파일 기준으로 교체됩니다.</p>
              </div>
              <button onClick={props.onPickBundleMaster} disabled={props.bundleMasterBusy} className="rounded-2xl bg-[#002542] px-5 py-3 font-semibold text-white disabled:opacity-60">엑셀 선택</button>
            </div>
            {props.bundleMasterSummary && <div className="mt-4 rounded-[1.5rem] bg-[#edf4fb] p-4 text-sm text-[#002542]">{props.bundleMasterSummary.fileName} / {props.bundleMasterSummary.recordCount.toLocaleString()}건</div>}
            {props.bundleMasterMessage && <p className="mt-4 whitespace-pre-line text-sm text-[#5b6670]">{props.bundleMasterMessage}</p>}
          </Panel>

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
  return <div className={`rounded-[1.75rem] border p-5 ${emphasize ? 'border-[#b6e1bd] bg-[#eef8ee]' : 'border-[#dce6f0] bg-[#f8fbfd]'}`}><div className="flex flex-col gap-4 md:flex-row md:justify-between"><div><p className="font-mono text-lg font-bold text-[#002542]">{match.record.barcode}</p><p className="mt-2 text-lg font-bold text-[#171c1f]">{match.record.name || '-'}</p><p className="mt-1 text-sm text-[#5b6670]">축약명 {match.record.shortName || '-'}</p></div><div className="flex flex-col items-start gap-2 md:items-end"><span className={`rounded-full px-3 py-1 text-xs font-bold ${emphasize ? 'bg-[#dff3e3] text-[#005c29]' : 'bg-[#e7f0fb] text-[#174f83]'}`}>{match.matchType === 'exact' ? 'EXACT' : match.matchType.toUpperCase()}</span><span className="text-sm text-[#5b6670]">유사도 {formatSimilarity(match.score)}</span></div></div>{match.reasons.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{match.reasons.map((reason) => <span key={reason} className="rounded-full border border-[#dce6f0] bg-white px-3 py-1 text-xs text-[#5b6670]">{reason}</span>)}</div>}<div className="mt-4"><BarcodePreview value={match.record.barcode} /></div></div>;
}

function BundleCard({ item }: { item: BundleMasterRecord }) {
  return <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-lg font-bold text-[#171c1f]">{item.bundleName}</p><p className="mt-1 font-mono text-sm text-[#002542]">번들 {item.bundleBarcode}</p></div><span className="rounded-full bg-[#d1e4ff] px-3 py-1 text-xs font-bold text-[#002542]">입수 {item.quantity}</span></div><div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"><InfoBox label="낱개 바코드" value={item.itemBarcode} mono /><InfoBox label="낱개 상품명" value={item.itemName} /></div></div>;
}

function ConvertedBarcodeCard({ item }: { item: ConvertedBarcodeItem }) {
  return <div className="rounded-[1.5rem] border border-[#dce6f0] bg-[#f8fbfd] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-lg font-bold text-[#002542]">{item.barcode}</p><p className="mt-2 text-lg font-bold text-[#171c1f]">{item.name}</p></div><span className="rounded-full bg-[#edf4fb] px-3 py-1 text-xs font-bold text-[#002542]">{item.rowNumber}행</span></div><div className="mt-4"><BarcodePreview value={item.barcode} /></div></div>;
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

  return new TextEncoder().encode(trimmed).length >= 6
    ? { canSearch: true, message: null }
    : { canSearch: false, message: '한글 또는 영문 검색은 최소 6byte부터 가능합니다.' };
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

function createHistoryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}






import { useEffect, useMemo, useRef } from 'react';
import JsBarcode from 'jsbarcode';

type BarcodePreviewProps = {
  value: string;
};

export function BarcodePreview({ value }: BarcodePreviewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const config = useMemo(() => getBarcodeConfig(value), [value]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    try {
      JsBarcode(svg, value, {
        format: config.format,
        displayValue: true,
        fontSize: 16,
        lineColor: '#111827',
        background: '#ffffff',
        margin: 12,
        height: 72,
        width: config.format === 'EAN13' ? 2 : 1.8,
        textMargin: 6,
      });
    } catch {
      svg.innerHTML = '';
    }
  }, [config.format, value]);

  if (!config.supported) {
    return (
      <div className="rounded-2xl border border-[#dce6f0] bg-white p-4 text-center text-sm text-[#5b6670]">
        바코드 생성 불가: 숫자/문자 형식이 지원되지 않습니다.
      </div>
    );
  }

  return (
    <div className="rounded-[1.5rem] border border-[#dce6f0] bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[#5b6670]">
        <span>생성 바코드</span>
        <span>{config.label}</span>
      </div>
      <div className="overflow-x-auto">
        <svg ref={svgRef} />
      </div>
    </div>
  );
}

function getBarcodeConfig(value: string) {
  if (/^\d{13}$/.test(value)) {
    return { supported: true, format: 'EAN13' as const, label: 'EAN-13' };
  }

  if (/^[\x20-\x7E]{1,40}$/.test(value)) {
    return { supported: true, format: 'CODE128' as const, label: 'CODE128' };
  }

  return { supported: false, format: 'CODE128' as const, label: 'Unsupported' };
}

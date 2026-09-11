export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function normalizeSheetRows(rows: unknown[][], maxRows = 200, maxColumns = 50): string[][] {
  return rows
    .slice(0, maxRows)
    .map((row) =>
      (Array.isArray(row) ? row : [])
        .slice(0, maxColumns)
        .map((value) => (value === null || value === undefined ? "" : String(value))),
    );
}

export async function convertDocxToHtml(base64: string): Promise<string> {
  const mammothModule = await import("mammoth/mammoth.browser");
  const mammoth = mammothModule.default ?? mammothModule;
  const result = await mammoth.convertToHtml({ arrayBuffer: base64ToArrayBuffer(base64) });
  return result.value;
}

export interface XlsxSheetPreview {
  name: string;
  rows: string[][];
}

export async function parseXlsxFirstSheet(base64: string): Promise<XlsxSheetPreview | null> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(base64, { type: "base64" });
  const name = workbook.SheetNames[0];
  if (!name) {
    return null;
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "" });
  return { name, rows: normalizeSheetRows(rows) };
}

export async function renderPptxInto(base64: string, container: HTMLElement, width: number): Promise<() => void> {
  const { loadPresentation, renderSlideToElement } = await import("pptx-viewer");
  const presentation = await loadPresentation(base64ToArrayBuffer(base64));
  container.replaceChildren();
  presentation.slides.forEach((_, index) => {
    const slideHost = document.createElement("div");
    slideHost.className = "file-pptx-slide";
    container.appendChild(slideHost);
    renderSlideToElement(presentation, index, slideHost, { width });
  });
  return () => presentation.cleanup();
}

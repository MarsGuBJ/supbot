/**
 * 文本编码嗅探与解码（jschardet + TextDecoder）。
 * 对应 k-pipeline 中 chardet 的使用点（router.sniff_csv / _looks_like_text、
 * text_pipeline 的 decode）。
 */

import jschardet from "jschardet";

/** jschardet 编码名 → TextDecoder label（Node full-ICU 支持 gb18030/big5/shift_jis 等）。 */
const ENCODING_LABELS: Record<string, string> = {
  "utf-8": "utf-8",
  ascii: "utf-8",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  "utf-16": "utf-16le",
  gb2312: "gb18030",
  gbk: "gb18030",
  gb18030: "gb18030",
  big5: "big5",
  "big5-hkscs": "big5-hkscs",
  shift_jis: "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  "iso-8859-1": "iso-8859-1",
  "windows-1252": "windows-1252",
};

/** BOM 优先于 jschardet（短文本上 chardet 对 UTF-16 容易误判）。 */
function sniffBom(raw: Buffer): string | null {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return "utf-8";
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return "utf-16le";
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return "utf-16be";
  }
  return null;
}

/** 检测字节序列的文本编码；无法判定时返回 null。 */
export function detectEncoding(raw: Buffer): string | null {
  const bom = sniffBom(raw);
  if (bom) {
    return bom;
  }
  const detected = jschardet.detect(raw).encoding;
  if (!detected) {
    return null;
  }
  const label = ENCODING_LABELS[detected.toLowerCase()];
  return label ?? "utf-8";
}

/** 按检测到的编码解码为字符串；未知编码退化为 utf-8（replace 模式，不抛错）。 */
export function decodeText(raw: Buffer, encoding?: string | null): string {
  const label = encoding ?? detectEncoding(raw) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(raw);
  } catch {
    return new TextDecoder("utf-8").decode(raw);
  }
}

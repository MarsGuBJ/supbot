import {
  FileExcelOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  FileWordOutlined,
  FileZipOutlined,
} from "@ant-design/icons";
import { fileTypeForName } from "../lib/fileType";

export function FileTypeIcon({
  name,
  mimeType,
  className = "",
}: {
  name: string;
  mimeType?: string;
  className?: string;
}) {
  const kind = fileTypeForName(name, mimeType);
  const icon =
    kind === "word" ? (
      <FileWordOutlined />
    ) : kind === "excel" ? (
      <FileExcelOutlined />
    ) : kind === "powerpoint" ? (
      <FilePptOutlined />
    ) : kind === "pdf" ? (
      <FilePdfOutlined />
    ) : kind === "image" ? (
      <FileImageOutlined />
    ) : kind === "archive" ? (
      <FileZipOutlined />
    ) : kind === "json" ? (
      <FileMarkdownOutlined />
    ) : kind === "text" ? (
      <FileTextOutlined />
    ) : (
      <FileUnknownOutlined />
    );
  return (
    <span className={`file-type-icon file-type-${kind} ${className}`.trim()} aria-hidden="true">
      {icon}
    </span>
  );
}

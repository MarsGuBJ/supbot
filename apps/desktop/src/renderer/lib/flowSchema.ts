import { message } from "antd";

export type FlowJsonSchema = Record<string, unknown>;
export type FlowLaunchFormValues = Record<string, unknown>;
export type FlowFilePayload = { fileName: string; contentType: string; contentBase64: string };

export type FlowInputField = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  schema: FlowJsonSchema;
  kind: "string" | "number" | "integer" | "boolean" | "file";
  enumValues?: Array<string | number | boolean | null>;
};

export function shouldUseJsonFlowInput(schema?: FlowJsonSchema) {
  if (!schema || Object.keys(schema).length === 0) {
    return false;
  }
  const type = getJsonSchemaType(schema);
  if (type && type !== "object") {
    return true;
  }
  const properties = getSchemaProperties(schema);
  return Object.values(properties).some((fieldSchema) => !isRenderableFlowField(fieldSchema));
}

export function getFlowInputFields(schema?: FlowJsonSchema): FlowInputField[] {
  const properties = getSchemaProperties(schema);
  const required = Array.isArray(schema?.required) ? schema.required.map(String) : [];
  return Object.entries(properties)
    .filter(([, fieldSchema]) => isRenderableFlowField(fieldSchema))
    .map(([name, fieldSchema]) => {
      const type = getJsonSchemaType(fieldSchema);
      const kind: FlowInputField["kind"] =
        type === "string" && fieldSchema.format === "file"
          ? "file"
          : type === "number" || type === "integer" || type === "boolean"
            ? type
            : "string";
      return {
        name,
        label: typeof fieldSchema.title === "string" && fieldSchema.title.trim() ? fieldSchema.title : name,
        description: typeof fieldSchema.description === "string" ? fieldSchema.description : undefined,
        required: required.includes(name),
        schema: fieldSchema,
        kind,
        enumValues: Array.isArray(fieldSchema.enum) ? fieldSchema.enum as FlowInputField["enumValues"] : undefined
      };
    });
}

export function getSchemaProperties(schema?: FlowJsonSchema): Record<string, FlowJsonSchema> {
  if (!schema || typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
    return {};
  }
  return schema.properties as Record<string, FlowJsonSchema>;
}

export function isRenderableFlowField(schema: FlowJsonSchema) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return true;
  }
  const type = getJsonSchemaType(schema) || "string";
  if (type === "string" && schema.format === "file") {
    return true;
  }
  return ["string", "number", "integer", "boolean"].includes(type);
}

export function getJsonSchemaType(schema?: FlowJsonSchema) {
  const rawType = schema?.type;
  if (Array.isArray(rawType)) {
    return rawType.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return typeof rawType === "string" ? rawType : undefined;
}

export function buildDefaultFlowInput(schema?: FlowJsonSchema) {
  if (shouldUseJsonFlowInput(schema)) {
    return {};
  }
  return Object.fromEntries(
    getFlowInputFields(schema)
      .map((field) => [field.name, getSchemaDefaultValue(field.schema)])
      .filter(([, value]) => value !== undefined)
  );
}

export function getSchemaDefaultValue(schema: FlowJsonSchema) {
  return "default" in schema ? schema.default : undefined;
}

export function coerceFlowInputValues(values: FlowLaunchFormValues, schema?: FlowJsonSchema) {
  const fields = getFlowInputFields(schema);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    result[field.name] = field.kind === "integer" || field.kind === "number" ? Number(value) : value;
  }
  return result;
}

export function parseFlowInputJson(value: string, errorMessage: string) {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(errorMessage);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(errorMessage);
  }
}

export function isFlowFilePayload(value: unknown): value is FlowFilePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FlowFilePayload).fileName === "string" &&
    typeof (value as FlowFilePayload).contentType === "string" &&
    typeof (value as FlowFilePayload).contentBase64 === "string"
  );
}

export function fileToFlowFilePayload(file: File): Promise<FlowFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const contentBase64 = result.includes(",") ? result.split(",")[1] : result;
      resolve({ fileName: file.name, contentType: file.type || "application/octet-stream", contentBase64 });
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function downloadFlowFilePayload(payload: FlowFilePayload) {
  try {
    const cleanedBase64 = payload.contentBase64.replace(/[^A-Za-z0-9+/=]/g, "");
    const bytes = Uint8Array.from(atob(cleanedBase64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: payload.contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = payload.fileName;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    message.error(`Download failed: ${reason}`);
  }
}

export function formatBytesFromBase64(base64: string): string {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

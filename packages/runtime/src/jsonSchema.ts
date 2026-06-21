export interface JsonSchemaValidationResult {
  ok: boolean;
  errors: string[];
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: unknown[];
  additionalProperties?: boolean;
  items?: unknown;
  enum?: unknown[];
  oneOf?: unknown[];
  anyOf?: unknown[];
};

export function validateJsonSchemaValue(value: unknown, schema: unknown, path = "input"): JsonSchemaValidationResult {
  const errors: string[] = [];
  validate(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

export function inspectJsonSchema(schema: unknown, path = "schema"): string[] {
  const warnings: string[] = [];
  inspect(schema, path, warnings);
  return warnings;
}

function validate(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  const current = schema as JsonSchema;
  if (Array.isArray(current.enum) && !current.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path} must be one of ${current.enum.map(String).join(", ")}.`);
    return;
  }
  if (Array.isArray(current.oneOf)) {
    const matches = current.oneOf.filter((item) => validateJsonSchemaValue(value, item, path).ok).length;
    if (matches !== 1) {
      errors.push(`${path} must match exactly one schema.`);
    }
    return;
  }
  if (Array.isArray(current.anyOf)) {
    const matches = current.anyOf.some((item) => validateJsonSchemaValue(value, item, path).ok);
    if (!matches) {
      errors.push(`${path} must match at least one schema.`);
    }
    return;
  }
  const types = Array.isArray(current.type) ? current.type : current.type ? [current.type] : [];
  if (types.length && !types.some((type) => matchesJsonType(value, type))) {
    errors.push(`${path} must be ${types.join(" or ")}.`);
    return;
  }
  if (types.includes("object") || current.properties || current.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be object.`);
      return;
    }
    const record = value as Record<string, unknown>;
    const properties = current.properties && typeof current.properties === "object" ? current.properties : {};
    for (const required of current.required || []) {
      if (typeof required === "string" && !(required in record)) {
        errors.push(`${path}.${required} is required.`);
      }
    }
    if (current.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(record).find((key) => !allowed.has(key));
      if (extra) {
        errors.push(`${path}.${extra} is not allowed.`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) {
        validate(record[key], childSchema, `${path}.${key}`, errors);
      }
    }
  }
  if (types.includes("array") || current.items) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array.`);
      return;
    }
    if (current.items) {
      value.forEach((item, index) => validate(item, current.items, `${path}[${index}]`, errors));
    }
  }
}

function inspect(schema: unknown, path: string, warnings: string[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    warnings.push(`${path} is not an object schema.`);
    return;
  }
  const current = schema as JsonSchema;
  const types = Array.isArray(current.type) ? current.type : current.type ? [current.type] : [];
  if (current.type && !types.every((type) => ["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) {
    warnings.push(`${path}.type has unsupported value.`);
  }
  const properties = current.properties && typeof current.properties === "object" && !Array.isArray(current.properties) ? current.properties : {};
  if (current.properties && properties !== current.properties) {
    warnings.push(`${path}.properties must be an object.`);
  }
  for (const required of current.required || []) {
    if (typeof required !== "string") {
      warnings.push(`${path}.required contains non-string entry.`);
    } else if (Object.keys(properties).length && !(required in properties)) {
      warnings.push(`${path}.required references missing property ${required}.`);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    inspect(child, `${path}.properties.${key}`, warnings);
  }
  if (current.items) {
    inspect(current.items, `${path}.items`, warnings);
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const value = current[keyword];
    if (value && !Array.isArray(value)) {
      warnings.push(`${path}.${keyword} must be an array.`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}.${keyword}[${index}]`, warnings));
    }
  }
}

function matchesJsonType(value: unknown, expected: string): boolean {
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "integer") {
    return Number.isInteger(value);
  }
  if (expected === "number") {
    return typeof value === "number";
  }
  if (expected === "boolean") {
    return typeof value === "boolean";
  }
  if (expected === "string") {
    return typeof value === "string";
  }
  if (expected === "null") {
    return value === null;
  }
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

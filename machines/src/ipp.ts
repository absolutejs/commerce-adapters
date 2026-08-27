/* Minimal IPP/1.1 (RFC 8010/8011) encoder + decoder — enough for Print-Job
 * and Get-Printer-Attributes over HTTP with `application/ipp`. */

export const IPP_OPERATIONS = {
  "get-printer-attributes": 0x000b,
  "print-job": 0x0002,
} as const;

export type IppOperation = keyof typeof IPP_OPERATIONS;

export const IPP_TAGS = {
  charset: 0x47,
  endOfAttributes: 0x03,
  integer: 0x21,
  jobAttributes: 0x02,
  keyword: 0x44,
  mimeMediaType: 0x49,
  nameWithoutLanguage: 0x42,
  naturalLanguage: 0x48,
  operationAttributes: 0x01,
  printerAttributes: 0x04,
  uri: 0x45,
} as const;

export type IppAttribute = {
  tag: number;
  name: string;
  value: string | number | Uint8Array;
};

export type IppRequest = {
  operation: IppOperation;
  requestId: number;
  operationAttributes: IppAttribute[];
  document?: Uint8Array;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const int32Bytes = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);

  return out;
};

const attributeBytes = ({ tag, name, value }: IppAttribute) => {
  const nameBytes = encoder.encode(name);
  const valueBytes =
    typeof value === "number"
      ? int32Bytes(value)
      : typeof value === "string"
        ? encoder.encode(value)
        : value;
  const out = new Uint8Array(1 + 2 + nameBytes.length + 2 + valueBytes.length);
  const view = new DataView(out.buffer);
  out[0] = tag;
  view.setUint16(1, nameBytes.length);
  out.set(nameBytes, 3);
  view.setUint16(3 + nameBytes.length, valueBytes.length);
  out.set(valueBytes, 5 + nameBytes.length);

  return out;
};

export const encodeIppRequest = (request: IppRequest) => {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  header[0] = 1;
  header[1] = 1;
  view.setUint16(2, IPP_OPERATIONS[request.operation]);
  view.setUint32(4, request.requestId >>> 0);
  parts.push(header, new Uint8Array([IPP_TAGS.operationAttributes]));
  for (const attribute of request.operationAttributes) {
    parts.push(attributeBytes(attribute));
  }
  parts.push(new Uint8Array([IPP_TAGS.endOfAttributes]));
  if (request.document) parts.push(request.document);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

export type IppPrintJobOptions = {
  printerUri: string;
  requestId?: number;
  user?: string;
  jobName: string;
  documentFormat?: string;
  document: Uint8Array;
};

export const encodePrintJob = (options: IppPrintJobOptions) =>
  encodeIppRequest({
    document: options.document,
    operation: "print-job",
    operationAttributes: [
      { name: "attributes-charset", tag: IPP_TAGS.charset, value: "utf-8" },
      {
        name: "attributes-natural-language",
        tag: IPP_TAGS.naturalLanguage,
        value: "en",
      },
      { name: "printer-uri", tag: IPP_TAGS.uri, value: options.printerUri },
      {
        name: "requesting-user-name",
        tag: IPP_TAGS.nameWithoutLanguage,
        value: options.user ?? "absolutejs",
      },
      {
        name: "job-name",
        tag: IPP_TAGS.nameWithoutLanguage,
        value: options.jobName,
      },
      {
        name: "document-format",
        tag: IPP_TAGS.mimeMediaType,
        value: options.documentFormat ?? "application/octet-stream",
      },
    ],
    requestId: options.requestId ?? 1,
  });

export const encodeGetPrinterAttributes = (printerUri: string, requestId = 1) =>
  encodeIppRequest({
    operation: "get-printer-attributes",
    operationAttributes: [
      { name: "attributes-charset", tag: IPP_TAGS.charset, value: "utf-8" },
      {
        name: "attributes-natural-language",
        tag: IPP_TAGS.naturalLanguage,
        value: "en",
      },
      { name: "printer-uri", tag: IPP_TAGS.uri, value: printerUri },
      {
        name: "requested-attributes",
        tag: IPP_TAGS.keyword,
        value: "printer-state",
      },
      {
        name: "requested-attributes",
        tag: IPP_TAGS.keyword,
        value: "printer-name",
      },
    ],
    requestId,
  });

export type IppResponse = {
  version: string;
  statusCode: number;
  requestId: number;
  attributes: IppAttribute[];
};

const INTEGER_TAGS = new Set([0x21, 0x22, 0x23]);

/** Decode the header + attribute groups of an IPP response (document data, if any, is ignored). */
export const decodeIppResponse = (
  bytes: Uint8Array,
): IppResponse | { error: string } => {
  if (bytes.length < 9) return { error: "IPP response too short" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = `${bytes[0]}.${bytes[1]}`;
  const statusCode = view.getUint16(2);
  const requestId = view.getUint32(4);
  const attributes: IppAttribute[] = [];
  let offset = 8;
  let lastName = "";
  while (offset < bytes.length) {
    const tag = bytes[offset];
    if (tag === undefined) break;
    offset += 1;
    if (tag === IPP_TAGS.endOfAttributes) break;
    if (tag < 0x10) continue; // group delimiter
    if (offset + 2 > bytes.length) return { error: "truncated attribute name" };
    const nameLength = view.getUint16(offset);
    offset += 2;
    const name =
      nameLength === 0
        ? lastName
        : decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    if (offset + 2 > bytes.length)
      return { error: "truncated attribute value" };
    const valueLength = view.getUint16(offset);
    offset += 2;
    const raw = bytes.subarray(offset, offset + valueLength);
    offset += valueLength;
    lastName = name;
    const value: IppAttribute["value"] =
      INTEGER_TAGS.has(tag) && valueLength === 4
        ? new DataView(raw.buffer, raw.byteOffset, 4).getInt32(0)
        : tag >= 0x40
          ? decoder.decode(raw)
          : raw;
    attributes.push({ name, tag, value });
  }

  return { attributes, requestId, statusCode, version };
};

const STATUS_NAMES: Record<number, string> = {
  0x0000: "successful-ok",
  0x0001: "successful-ok-ignored-or-substituted-attributes",
  0x0002: "successful-ok-conflicting-attributes",
  0x0400: "client-error-bad-request",
  0x0401: "client-error-forbidden",
  0x0402: "client-error-not-authenticated",
  0x0403: "client-error-not-authorized",
  0x0404: "client-error-not-possible",
  0x0405: "client-error-timeout",
  0x0406: "client-error-not-found",
  0x0407: "client-error-gone",
  0x0408: "client-error-request-entity-too-large",
  0x0409: "client-error-request-value-too-long",
  0x040a: "client-error-document-format-not-supported",
  0x040b: "client-error-attributes-or-values-not-supported",
  0x040c: "client-error-uri-scheme-not-supported",
  0x040d: "client-error-charset-not-supported",
  0x040e: "client-error-conflicting-attributes",
  0x040f: "client-error-compression-not-supported",
  0x0410: "client-error-compression-error",
  0x0411: "client-error-document-format-error",
  0x0412: "client-error-document-access-error",
  0x0500: "server-error-internal-error",
  0x0501: "server-error-operation-not-supported",
  0x0502: "server-error-service-unavailable",
  0x0503: "server-error-version-not-supported",
  0x0504: "server-error-device-error",
  0x0505: "server-error-temporary-error",
  0x0506: "server-error-not-accepting-jobs",
  0x0507: "server-error-busy",
  0x0508: "server-error-job-canceled",
  0x0509: "server-error-multiple-document-jobs-not-supported",
};

export const ippStatusName = (code: number) =>
  STATUS_NAMES[code] ?? `0x${code.toString(16).padStart(4, "0")}`;

export const ippStatusOk = (code: number) => code <= 0x00ff;

/** `ipp://host:631/ipp/print` → `http://host:631/ipp/print` (ipps → https). */
export const ippToHttpUrl = (url: string) =>
  url.replace(/^ipps:\/\//i, "https://").replace(/^ipp:\/\//i, "http://");

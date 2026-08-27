/* A minimal SNMP v1 / v2c codec — BER encode and decode for exactly what
 * printer telemetry needs: a GetRequest (the settings screen's test reading)
 * and decoding the traps and informs a printer pushes at us. No dependency.
 *
 * Deliberately not a general SNMP library: no v3, no walks, no MIB parsing. */

export const SNMP_SEQUENCE = 0x30;
export const SNMP_INTEGER = 0x02;
export const SNMP_OCTET_STRING = 0x04;
export const SNMP_NULL = 0x05;
export const SNMP_OID = 0x06;
export const SNMP_IP_ADDRESS = 0x40;
export const SNMP_COUNTER32 = 0x41;
export const SNMP_GAUGE32 = 0x42;
export const SNMP_TIMETICKS = 0x43;
export const SNMP_OPAQUE = 0x44;
export const SNMP_COUNTER64 = 0x46;
export const SNMP_NO_SUCH_OBJECT = 0x80;
export const SNMP_NO_SUCH_INSTANCE = 0x81;
export const SNMP_END_OF_MIB = 0x82;

export const PDU_GET_REQUEST = 0xa0;
export const PDU_GET_NEXT = 0xa1;
export const PDU_RESPONSE = 0xa2;
export const PDU_SET = 0xa3;
export const PDU_TRAP_V1 = 0xa4;
export const PDU_GET_BULK = 0xa5;
export const PDU_INFORM = 0xa6;
export const PDU_TRAP_V2 = 0xa7;

/** `snmpTrapOID.0` — the varbind naming which trap fired (v2c/inform). */
export const SNMP_TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0";
/** `sysUpTime.0` — the first varbind of every v2c trap. */
export const SNMP_SYS_UPTIME_OID = "1.3.6.1.2.1.1.3.0";

export type SnmpValue = number | string | null;

export type SnmpVarbind = { oid: string; value: SnmpValue };

export type SnmpMessage = {
  /** 0 = v1, 1 = v2c. */
  version: number;
  community: string;
  pduTag: number;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: SnmpVarbind[];
  /** v1 traps only. */
  v1?: {
    enterprise: string;
    agentAddress: string;
    genericTrap: number;
    specificTrap: number;
    timeTicks: number;
  };
};

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

export const encodeLength = (length: number): Uint8Array => {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
};

export const encodeTlv = (tag: number, contents: Uint8Array): Uint8Array =>
  concat([new Uint8Array([tag]), encodeLength(contents.length), contents]);

export const encodeInteger = (
  value: number,
  tag = SNMP_INTEGER,
): Uint8Array => {
  const bytes: number[] = [];
  let rest = Math.trunc(value);
  if (rest === 0) bytes.push(0);
  while (rest !== 0 && rest !== -1) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  if (value >= 0 && bytes.length > 0 && (bytes[0] ?? 0) & 0x80)
    bytes.unshift(0);
  if (value < 0) {
    if (bytes.length === 0) bytes.push(0xff);
    else if (!((bytes[0] ?? 0) & 0x80)) bytes.unshift(0xff);
  }

  return encodeTlv(tag, new Uint8Array(bytes));
};

const encodeBase128 = (value: number): number[] => {
  const bytes = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }

  return bytes;
};

export const encodeOidContents = (oid: string): Uint8Array => {
  const arcs = oid
    .replace(/^\./, "")
    .split(".")
    .map((arc) => Number(arc));
  if (arcs.length < 2 || arcs.some((arc) => !Number.isFinite(arc))) {
    throw new Error(`invalid OID: ${oid}`);
  }
  const bytes: number[] = [(arcs[0] ?? 0) * 40 + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) bytes.push(...encodeBase128(arc));

  return new Uint8Array(bytes);
};

export const encodeOid = (oid: string) =>
  encodeTlv(SNMP_OID, encodeOidContents(oid));

const encodeValue = (value: SnmpValue): Uint8Array => {
  if (value === null) return encodeTlv(SNMP_NULL, new Uint8Array());
  if (typeof value === "number") return encodeInteger(value);

  return encodeTlv(SNMP_OCTET_STRING, new TextEncoder().encode(value));
};

const encodeVarbinds = (varbinds: SnmpVarbind[]) =>
  encodeTlv(
    SNMP_SEQUENCE,
    concat(
      varbinds.map((varbind) =>
        encodeTlv(
          SNMP_SEQUENCE,
          concat([encodeOid(varbind.oid), encodeValue(varbind.value)]),
        ),
      ),
    ),
  );

export type SnmpGetOptions = {
  oids: string[];
  community?: string;
  requestId?: number;
  /** 0 = v1, 1 = v2c (default). */
  version?: number;
};

/** A GetRequest for the given OIDs — used only by the explicit test reading. */
export const encodeSnmpGet = ({
  community = "public",
  oids,
  requestId = Math.floor(Math.random() * 0x7fffffff) + 1,
  version = 1,
}: SnmpGetOptions): Uint8Array =>
  encodeTlv(
    SNMP_SEQUENCE,
    concat([
      encodeInteger(version),
      encodeTlv(SNMP_OCTET_STRING, new TextEncoder().encode(community)),
      encodeTlv(
        PDU_GET_REQUEST,
        concat([
          encodeInteger(requestId),
          encodeInteger(0),
          encodeInteger(0),
          encodeVarbinds(oids.map((oid) => ({ oid, value: null }))),
        ]),
      ),
    ]),
  );

/** The Response an inform expects back, echoing its request id and varbinds. */
export const encodeSnmpInformResponse = (message: SnmpMessage): Uint8Array =>
  encodeTlv(
    SNMP_SEQUENCE,
    concat([
      encodeInteger(message.version),
      encodeTlv(SNMP_OCTET_STRING, new TextEncoder().encode(message.community)),
      encodeTlv(
        PDU_RESPONSE,
        concat([
          encodeInteger(message.requestId),
          encodeInteger(0),
          encodeInteger(0),
          encodeVarbinds(message.varbinds),
        ]),
      ),
    ]),
  );

// ------------------------------------------------------------------ decode

type Cursor = { bytes: Uint8Array; at: number };

type Tlv = { tag: number; contents: Uint8Array; end: number };

const readTlv = (cursor: Cursor): Tlv => {
  const tag = cursor.bytes[cursor.at];
  if (tag === undefined) throw new Error("truncated: no tag");
  let at = cursor.at + 1;
  const first = cursor.bytes[at];
  if (first === undefined) throw new Error("truncated: no length");
  at += 1;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error("unsupported length form");
    length = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = cursor.bytes[at + index];
      if (byte === undefined) throw new Error("truncated: length");
      length = length * 256 + byte;
    }
    at += count;
  }
  const end = at + length;
  if (end > cursor.bytes.length) throw new Error("truncated: contents");
  cursor.at = end;

  return { contents: cursor.bytes.subarray(at, end), end, tag };
};

const readUnsigned = (bytes: Uint8Array) => {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;

  return value;
};

const readSigned = (bytes: Uint8Array) => {
  if (bytes.length === 0) return 0;
  const negative = ((bytes[0] ?? 0) & 0x80) !== 0;
  const magnitude = readUnsigned(bytes);

  return negative ? magnitude - 256 ** bytes.length : magnitude;
};

export const decodeOidContents = (bytes: Uint8Array): string => {
  const first = bytes[0] ?? 0;
  const arcs = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }

  return arcs.join(".");
};

const decodeValue = (tlv: Tlv): SnmpValue => {
  switch (tlv.tag) {
    case SNMP_INTEGER:
      return readSigned(tlv.contents);
    case SNMP_COUNTER32:
    case SNMP_GAUGE32:
    case SNMP_TIMETICKS:
    case SNMP_COUNTER64:
      return readUnsigned(tlv.contents);
    case SNMP_OID:
      return decodeOidContents(tlv.contents);
    case SNMP_IP_ADDRESS:
      return Array.from(tlv.contents).join(".");
    case SNMP_NULL:
    case SNMP_NO_SUCH_OBJECT:
    case SNMP_NO_SUCH_INSTANCE:
    case SNMP_END_OF_MIB:
      return null;
    default:
      return new TextDecoder().decode(tlv.contents).replace(/ +$/, "");
  }
};

const decodeVarbinds = (bytes: Uint8Array): SnmpVarbind[] => {
  const list = readTlv({ at: 0, bytes });
  const cursor: Cursor = { at: 0, bytes: list.contents };
  const varbinds: SnmpVarbind[] = [];
  while (cursor.at < cursor.bytes.length) {
    const pair = readTlv(cursor);
    const inner: Cursor = { at: 0, bytes: pair.contents };
    const oid = readTlv(inner);
    const value = readTlv(inner);
    varbinds.push({
      oid: decodeOidContents(oid.contents),
      value: decodeValue(value),
    });
  }

  return varbinds;
};

/** Decode any SNMP v1/v2c message: response, trap, or inform. */
export const decodeSnmpMessage = (
  bytes: Uint8Array,
): SnmpMessage | { error: string } => {
  try {
    const envelope = readTlv({ at: 0, bytes });
    if (envelope.tag !== SNMP_SEQUENCE) return { error: "not a SEQUENCE" };
    const cursor: Cursor = { at: 0, bytes: envelope.contents };
    const version = readSigned(readTlv(cursor).contents);
    const community = new TextDecoder().decode(readTlv(cursor).contents);
    const pdu = readTlv(cursor);
    const inner: Cursor = { at: 0, bytes: pdu.contents };
    if (pdu.tag === PDU_TRAP_V1) {
      const enterprise = decodeOidContents(readTlv(inner).contents);
      const agentAddress = Array.from(readTlv(inner).contents).join(".");
      const genericTrap = readSigned(readTlv(inner).contents);
      const specificTrap = readSigned(readTlv(inner).contents);
      const timeTicks = readUnsigned(readTlv(inner).contents);

      return {
        community,
        errorIndex: 0,
        errorStatus: 0,
        pduTag: pdu.tag,
        requestId: 0,
        v1: {
          agentAddress,
          enterprise,
          genericTrap,
          specificTrap,
          timeTicks,
        },
        varbinds: decodeVarbinds(inner.bytes.subarray(inner.at)),
        version,
      };
    }
    const requestId = readSigned(readTlv(inner).contents);
    const errorStatus = readSigned(readTlv(inner).contents);
    const errorIndex = readSigned(readTlv(inner).contents);

    return {
      community,
      errorIndex,
      errorStatus,
      pduTag: pdu.tag,
      requestId,
      varbinds: decodeVarbinds(inner.bytes.subarray(inner.at)),
      version,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/** Varbinds as an OID-keyed record, dropping nulls — ready for decoding. */
export const varbindRecord = (
  varbinds: SnmpVarbind[],
): Record<string, number | string> =>
  Object.fromEntries(
    varbinds.flatMap((varbind) =>
      varbind.value === null ? [] : [[varbind.oid, varbind.value]],
    ),
  );

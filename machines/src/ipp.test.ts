import { describe, expect, test } from "bun:test";
import {
  decodeIppResponse,
  encodeGetPrinterAttributes,
  encodePrintJob,
  ippStatusName,
  ippToHttpUrl,
} from "./ipp";

const attr = (tag: number, name: string, value: string) => [
  tag,
  0,
  name.length,
  ...Buffer.from(name),
  0,
  value.length,
  ...Buffer.from(value),
];

describe("IPP encoder", () => {
  test("Print-Job byte layout", () => {
    const document = new Uint8Array([0x5e, 0x58, 0x41]); // ^XA
    const bytes = encodePrintJob({
      document,
      documentFormat: "text/x-zpl",
      jobName: "ORD-1",
      printerUri: "ipp://p:631/ipp/print",
      requestId: 7,
      user: "shop",
    });
    const expected = new Uint8Array([
      1,
      1, // version 1.1
      0,
      2, // Print-Job
      0,
      0,
      0,
      7, // request-id
      1, // operation-attributes-tag
      ...attr(0x47, "attributes-charset", "utf-8"),
      ...attr(0x48, "attributes-natural-language", "en"),
      ...attr(0x45, "printer-uri", "ipp://p:631/ipp/print"),
      ...attr(0x42, "requesting-user-name", "shop"),
      ...attr(0x42, "job-name", "ORD-1"),
      ...attr(0x49, "document-format", "text/x-zpl"),
      3, // end-of-attributes
      ...document,
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  test("Get-Printer-Attributes has the right operation id and no document", () => {
    const bytes = encodeGetPrinterAttributes("ipp://p/ipp/print", 3);
    expect(bytes[2]).toBe(0);
    expect(bytes[3]).toBe(0x0b);
    expect(bytes[bytes.length - 1]).toBe(3);
  });

  test("decodes a response with job-id and status", () => {
    const response = new Uint8Array([
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      7,
      1,
      ...attr(0x47, "attributes-charset", "utf-8"),
      2, // job-attributes
      0x21,
      0,
      6,
      ...Buffer.from("job-id"),
      0,
      4,
      0,
      0,
      0,
      42,
      0x45,
      0,
      7,
      ...Buffer.from("job-uri"),
      0,
      5,
      ...Buffer.from("ipp:/"),
      3,
    ]);
    const decoded = decodeIppResponse(response);
    if ("error" in decoded) throw new Error(decoded.error);
    expect(decoded.statusCode).toBe(0);
    expect(decoded.requestId).toBe(7);
    expect(decoded.attributes.find((a) => a.name === "job-id")?.value).toBe(42);
    expect(decoded.attributes.find((a) => a.name === "job-uri")?.value).toBe(
      "ipp:/",
    );
  });

  test("status names and url mapping", () => {
    expect(ippStatusName(0x0406)).toBe("client-error-not-found");
    expect(ippStatusName(0x0999)).toBe("0x0999");
    expect(ippToHttpUrl("ipp://h:631/ipp/print")).toBe(
      "http://h:631/ipp/print",
    );
    expect(ippToHttpUrl("ipps://h/ipp/print")).toBe("https://h/ipp/print");
  });
});

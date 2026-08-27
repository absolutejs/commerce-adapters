export type {
  MachineChecklistStep,
  MachineConnection,
  MachineExport,
  MachineFormat,
  MachineHoop,
  MachineJob,
  MachineKind,
  MachineProvider,
  Stitch,
  StitchCommand,
  StitchFormat,
  StitchProgram,
} from "./types";
export {
  MACHINE_PROVIDERS,
  getMachineProvider,
  listMachineProviders,
  providersForFormat,
} from "./providers";
export {
  STITCH_FORMATS,
  decodeStitchProgram,
  encodeStitchProgram,
  isStitchFormat,
} from "./stitch";
export {
  MIME_BY_FORMAT,
  convertMachineFile,
  exportForMachine,
  formatForArtwork,
  machineChecklist,
  sanitiseFilename,
} from "./export";
export { PEC_THREADS, JEF_THREADS } from "./palettes";

import { exportForMachine, machineChecklist } from "./export";
import { MACHINE_PROVIDERS, getMachineProvider } from "./providers";
import type {
  MachineFormat,
  MachineJob,
  MachineKind,
  MachineProvider,
} from "./types";

export type MachineRegistryConfig = {
  /** Ids of the machines the shop owns (defaults to every provider). */
  owned?: string[];
  /** Extra providers the shop defines itself (a custom or unlisted machine). */
  custom?: MachineProvider[];
};

export type MachineRegistry = {
  providers: MachineProvider[];
  get: (id: string) => MachineProvider | undefined;
  list: (kind?: MachineKind) => MachineProvider[];
  forFormat: (format: MachineFormat) => MachineProvider[];
  checklist: (kind: MachineKind) => ReturnType<typeof machineChecklist>;
  exportJob: (
    providerId: string,
    job: MachineJob,
  ) => ReturnType<typeof exportForMachine>;
};

/** The shop's configured machines — the built-in catalogue filtered to what it owns. */
export const createMachineRegistry = (
  config: MachineRegistryConfig = {},
): MachineRegistry => {
  const custom = config.custom ?? [];
  const builtIn = config.owned
    ? config.owned.flatMap((id) => {
        const provider = getMachineProvider(id);

        return provider ? [provider] : [];
      })
    : MACHINE_PROVIDERS;
  const providers = [...builtIn, ...custom];
  const get = (id: string) => providers.find((provider) => provider.id === id);

  return {
    checklist: machineChecklist,
    exportJob: (providerId, job) => {
      const provider = get(providerId);

      return provider
        ? exportForMachine(provider, job)
        : { error: `unknown machine ${providerId}` };
    },
    forFormat: (format) =>
      providers.filter((provider) => provider.formats.includes(format)),
    get,
    list: (kind) =>
      kind
        ? providers.filter((provider) => provider.kind === kind)
        : [...providers],
    providers,
  };
};

export type {
  BridgeAction,
  BridgeActionKind,
  BridgeFile,
  BridgeHandlers,
  BridgeInfo,
  BridgeJob,
  BridgeJobStatus,
  BridgeStatus,
  BridgeStore,
  BridgeTelemetryRequest,
  BridgeTelemetryResponse,
  SendResult,
} from "./bridge";
export {
  BRIDGE_ACTION_KINDS,
  createBridgeHandlers,
  createMemoryBridgeStore,
} from "./bridge";
export type {
  BridgeSync,
  BridgeSyncContext,
  BridgeSyncOptions,
  BridgeCollectionDefinition,
  BridgeMutationDefinition,
} from "./bridgeSync";
export {
  BRIDGE_JOBS_COLLECTION,
  BRIDGE_SOURCES_COLLECTION,
  BRIDGE_REPORT_MUTATION,
  BRIDGE_TELEMETRY_MUTATION,
  BRIDGE_HEARTBEAT_MUTATION,
  bridgeTopic,
  createBridgeSync,
  publishTelemetrySource,
  withBridgeSyncPublishing,
} from "./bridgeSync";
export type {
  MachineReading,
  MachineRun,
  MachineRunEvent,
  MachineRunEventKind,
  MachineRunState,
  ReportParser,
  TelemetryBinding,
  TelemetryDelivery,
  TelemetryField,
  TelemetryKind,
  TelemetrySource,
  ZebraDialect,
} from "./telemetry";
export {
  DEFAULT_ALERT_PORT,
  DEFAULT_IDLE_GAP_SECONDS,
  DEFAULT_SNMP_COMMUNITY,
  DEFAULT_SNMP_PORT,
  DEFAULT_SNMP_TRAP_PORT,
  DEFAULT_STATUS_PORT,
  DEFAULT_ZEBRA_QUERY,
  REPORT_PARSERS,
  SNMP_PRINTER_OID_LIST,
  TELEMETRY_KINDS,
  TELEMETRY_LABELS,
  decodeSnmpPrinterStatus,
  decodeZebraAlert,
  decodeZebraStatus,
  eventsToRuns,
  isMachineReading,
  isMachineRunEvent,
  isTelemetryBinding,
  isTelemetrySource,
  parseDurationSeconds,
  parseMachineReport,
  parseReportTimestamp,
  readingsToRuns,
  referenceFromJobName,
  snmpPrinterOids,
  stateFromText,
  telemetryDelivery,
  telemetryFieldsFor,
  telemetryHelp,
  telemetryKindsFor,
} from "./telemetry";
export type {
  MachineTarget,
  MachineTransport,
  MachineTransportKind,
  MachineTransports,
  SendContext,
  TransportField,
} from "./transports";
export {
  MACHINE_TRANSPORT_KINDS,
  TRANSPORT_LABELS,
  createTransports,
  describeTarget,
  probeMachine,
  sendToMachine,
  transportFieldsFor,
  transportHelp,
} from "./transports";

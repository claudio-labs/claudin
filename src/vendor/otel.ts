/**
 * Local no-op OpenTelemetry shim.
 *
 * Claudin never emits telemetry: every module that value-imports OpenTelemetry
 * (`instrumentation`, `sessionTracing`, the first-party/BigQuery exporters,
 * `analytics/*`) is replaced with a no-op stub at build time by
 * `scripts/no-telemetry-plugin.ts`, and `bun run verify:privacy` enforces that
 * no `@opentelemetry/*` import survives into `dist/`. The remaining source
 * references are type-only annotations in files that ship (`bootstrap/state`,
 * `telemetryAttributes`, `events`, `init`, `logger`, `betaSessionTracing`).
 *
 * This module lets `tsc` resolve those symbols without pulling the real
 * `@opentelemetry/*` packages into `devDependencies`. The values below are
 * deliberately inert; they only exist so type-checking of the (stubbed)
 * telemetry sources succeeds. Do not wire real exporters through here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Types (@opentelemetry/api, api-logs, core, sdk-*) ───────────────────────
export type Attributes = Record<string, any>
export type AnyValueMap = Record<string, any>
export type Meter = any
export type MetricOptions = any
export type HrTime = [seconds: number, nanoseconds: number]
export type Span = any
export type Logger = any
export type ExportResult = any
export type ReadableLogRecord = any

// Metric shapes are given enough structure that the `.scopeMetrics`/`.metrics`/
// `.dataPoints` traversals in the (build-stubbed) exporters infer their element
// types instead of tripping `noImplicitAny`.
export interface DataPoint<T = number> {
  value: T
  attributes: Attributes
  startTime: HrTime
  endTime: HrTime
}
export interface MetricData {
  descriptor: { name: string; description: string; unit: string }
  dataPointType: unknown
  dataPoints: DataPoint[]
}
export interface ScopeMetrics {
  scope: unknown
  metrics: MetricData[]
}
export interface ResourceMetrics {
  resource: { attributes: Attributes }
  scopeMetrics: ScopeMetrics[]
}

export interface DiagLogger {
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  verbose(message: string, ...args: unknown[]): void
}

// Exporter contracts are implemented by the (build-stubbed) exporter classes;
// empty interfaces keep those `implements` clauses satisfied.
export interface LogRecordExporter {}
export interface PushMetricExporter {}

// ── No-op values ────────────────────────────────────────────────────────────
export const DiagLogLevel: any = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
  VERBOSE: 5,
  ALL: 9,
}

export const diag: any = {
  setLogger() {},
  verbose() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export const trace: any = {
  getTracer: () => ({
    startSpan: () => ({
      end() {},
      setAttribute() {},
      setAttributes() {},
      setStatus() {},
      recordException() {},
      addEvent() {},
    }),
  }),
  getSpan() {},
  setSpan(_ctx: any, _span: any) {},
}

export const context: any = {
  active: () => ({}),
  with: (_ctx: any, fn: (...args: any[]) => any) => fn(),
}

export const logs: any = {
  getLogger: () => ({ emit() {} }),
  setGlobalLoggerProvider() {},
}

export const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const

export type AggregationTemporality = number
export const AggregationTemporality: any = { DELTA: 0, CUMULATIVE: 1 }

export const resourceFromAttributes: any = (_attrs: any) => ({})
export const envDetector: any = {}
export const hostDetector: any = {}
export const osDetector: any = {}

export const ATTR_SERVICE_NAME = 'service.name'
export const ATTR_SERVICE_VERSION = 'service.version'
export const SEMRESATTRS_HOST_ARCH = 'host.arch'

// Classes double as both value and type references (e.g. `LoggerProvider | null`).
export class LoggerProvider {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class MeterProvider {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class BasicTracerProvider {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class BatchLogRecordProcessor {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class ConsoleLogRecordExporter {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class ConsoleMetricExporter {
  constructor(..._args: any[]) {}
  export(
    _metrics: ResourceMetrics,
    _resultCallback: (result: ExportResult) => void,
  ): void {}
  [key: string]: any
}
export class PeriodicExportingMetricReader {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class BatchSpanProcessor {
  constructor(..._args: any[]) {}
  [key: string]: any
}
export class ConsoleSpanExporter {
  constructor(..._args: any[]) {}
  [key: string]: any
}

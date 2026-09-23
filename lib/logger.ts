// Structured JSON-line logger.
//
// Every worker and API event is logged as a single JSON object so that a job's
// full lifecycle can be reconstructed from logs. Events intentionally carry
// small, useful fields (workerId, jobId, concurrency counts) and NEVER carry
// secrets, email bodies, or API keys.

export interface LogSink {
  line(obj: Record<string, unknown>): void;
}

export interface LoggerHandle {
  setWorkerId(workerId: string): void;
  log(event: string, extra?: Record<string, unknown>): void;
  error(event: string, extra?: Record<string, unknown>): void;
  setSink(sink: LogSink): void;
  getSink(): LogSink;
}

const EMPTY_SINK: LogSink = {
  line(obj) {
    console.log(JSON.stringify(obj));
  },
};

let workerId = process.env.WORKER_ID ?? "";
let sink: LogSink = EMPTY_SINK;

function emit(
  level: "info" | "error",
  event: string,
  extra?: Record<string, unknown>,
): void {
  const obj: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
  };
  if (workerId) obj.workerId = workerId;
  Object.assign(obj, extra ?? {});
  sink.line(obj);
}

export const logger: LoggerHandle = {
  setWorkerId(id: string) {
    workerId = id;
  },
  setSink(s: LogSink) {
    sink = s;
  },
  getSink() {
    return sink;
  },
  log(event, extra) {
    emit("info", event, extra);
  },
  error(event, extra) {
    emit("error", event, extra);
  },
};
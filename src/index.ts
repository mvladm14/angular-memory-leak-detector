export { provideMemoryLeakDetector } from "./provider.js";
export { startMemoryLeakDetector, type LeakDetectorApi } from "./detector.js";
export type {
  InstanceKind,
  LeakDetectorOptions,
  LeakEvent,
  LeakListener,
  ReportRow,
  RetainedInstances,
} from "./types.js";

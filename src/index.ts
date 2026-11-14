export { provideMemoryLeakDetector } from "./provider.js";
export { startMemoryLeakDetector, type LeakDetectorApi } from "./detector.js";
export type {
  LeakDetectorOptions,
  LeakEvent,
  LeakListener,
  ReportRow,
} from "./types.js";

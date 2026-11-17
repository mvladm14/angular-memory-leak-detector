export { provideMemoryLeakDetector, provideProductionMemoryLeakDetector } from "./provider.js";
export {
  startMemoryLeakDetector,
  startProductionMemoryLeakDetector,
  type LeakDetectorApi,
} from "./detector.js";
export type {
  ClassRef,
  HostCount,
  InstanceKind,
  LeakDetectorOptions,
  LeakEvent,
  LeakListener,
  ReportRow,
  RetainedInstances,
} from "./types.js";

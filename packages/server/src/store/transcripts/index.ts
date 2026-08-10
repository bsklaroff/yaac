// The public interface of the transcript store: where each tool keeps its
// records on disk, the project-relative path convention that names them,
// and the JSONL scanner the per-tool readers share. Everything outside this
// directory imports `#store/transcripts`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Adding a name here widens the
// interface and obliges a unit test in
// packages/server/test/store/transcripts/.

export { scanJsonlForward } from './jsonl'
export {
  piSessionLogs,
  resolveProjectPath,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from './transcripts'

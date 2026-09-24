// Registers `toHaveDiagnostic`, `toHaveNoDiagnostics`, `toStayWithinRerunBudget`,
// … on vitest's `expect`. The matchers take a `DiagnosticsArtifact` produced by
// `captureArtifact`, which is what every test in this suite asserts against.
import "@solidjs/diagnostics/vitest";

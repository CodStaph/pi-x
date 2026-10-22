import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { runStartupMigrations } from "@/lib/migrations";
import { startScheduler } from "@/lib/scheduled-tasks";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // Data migrations for pi-web's own files run once, before anything else can
  // write. The runner logs a failure and keeps the server up (lib/migrations).
  void runStartupMigrations().catch((error) => {
    console.error("[pi-web] migrations could not run:", error);
  });

  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") startScheduler();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

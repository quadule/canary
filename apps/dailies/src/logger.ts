import { createRootLogger } from "dailies-cli-kit";
import type { Logger } from "dailies-logger";

// Root CLI logger. Diagnostics go to stderr; stdout stays clean for
// machine-readable output. See dailies-cli-kit createRootLogger.
export const logger: Logger = createRootLogger("dailies");

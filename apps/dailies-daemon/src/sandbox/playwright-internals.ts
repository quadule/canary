import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

export type WireMessage = Record<string, unknown>;

export interface PlaywrightClientLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<Browser>;
  };
}

export interface ClientConnectionLike {
  close(cause?: string): void;
  dispatch(message: WireMessage): void;
  initializePlaywright(): Promise<PlaywrightClientLike>;
  onmessage: (message: WireMessage) => void;
}

export interface DispatcherConnectionLike {
  dispatch(message: WireMessage): Promise<void>;
  onmessage: (message: WireMessage) => void;
}

export interface RootDispatcherLike {
  _dispose(): void;
}

export interface PlaywrightDispatcherLike {
  cleanup(): Promise<void>;
}

export interface RootInitializeParams {
  sdkLanguage?: string;
}

export interface HostBridgeDispatcherOptions {
  denyLaunch?: boolean;
  preLaunchedBrowser?: unknown;
  sharedBrowser?: boolean;
}

function resolveCoreBundlePath(): string {
  const candidates = [
    path.resolve(
      currentDir,
      "../../node_modules/playwright-core/lib/coreBundle.js"
    ),
    path.resolve(currentDir, "node_modules/playwright-core/lib/coreBundle.js"),
    path.resolve(
      process.cwd(),
      "node_modules/playwright-core/lib/coreBundle.js"
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not locate playwright-core/lib/coreBundle.js");
}

interface CoreBundle {
  inprocess: {
    createInProcessPlaywright: () => {
      _connection: {
        constructor: new (platform: unknown) => ClientConnectionLike;
      };
    };
  };
  server: {
    createPlaywright: (options: { sdkLanguage: string }) => unknown;
    DispatcherConnection: new (isLocal?: boolean) => DispatcherConnectionLike;
    RootDispatcher: new (
      connection: DispatcherConnectionLike,
      createPlaywright?: (
        scope: unknown,
        params: RootInitializeParams
      ) => Promise<unknown>
    ) => RootDispatcherLike;
    PlaywrightDispatcher: new (
      scope: unknown,
      playwright: unknown,
      options?: HostBridgeDispatcherOptions
    ) => PlaywrightDispatcherLike;
  };
  utils: { nodePlatform: (coreDir: string) => unknown };
}

const bundlePath = resolveCoreBundlePath();
const bundle = require(bundlePath) as CoreBundle;

export const {
  createPlaywright,
  DispatcherConnection,
  RootDispatcher,
  PlaywrightDispatcher,
} = bundle.server;

// nodePlatform is a factory in 1.60+: call it with coreDir to get an instance.
export const nodePlatform: unknown = bundle.utils.nodePlatform(
  path.dirname(bundlePath)
);

// Connection is no longer a named export in 1.60+; extract it from a throwaway in-process instance.
export const Connection: new (platform: unknown) => ClientConnectionLike =
  (() => {
    const tmp = bundle.inprocess.createInProcessPlaywright();
    const ctor = (
      tmp as {
        _connection?: {
          constructor: new (platform: unknown) => ClientConnectionLike;
        };
      }
    )._connection?.constructor;
    if (!ctor) {
      throw new Error(
        "Could not extract Connection constructor from playwright-core inprocess bundle"
      );
    }
    return ctor;
  })();

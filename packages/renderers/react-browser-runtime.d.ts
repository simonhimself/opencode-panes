export interface ReactBrowserRuntime {
  source: string;
  wasm: Uint8Array;
}

export function getReactBrowserRuntime(): Promise<ReactBrowserRuntime>;

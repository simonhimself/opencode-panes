import type { BuildOptions, Plugin } from "esbuild-wasm";

export const SUPPORTED_REACT_IMPORTS = ["react"] as const;

const PUBLIC_REACT_EXPORTS = [
  "Activity",
  "Children",
  "Component",
  "Fragment",
  "Profiler",
  "PureComponent",
  "StrictMode",
  "Suspense",
  "act",
  "cache",
  "cacheSignal",
  "captureOwnerStack",
  "cloneElement",
  "createContext",
  "createElement",
  "createRef",
  "forwardRef",
  "isValidElement",
  "lazy",
  "memo",
  "startTransition",
  "use",
  "useActionState",
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useEffectEvent",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
  "version",
] as const;

const ARTIFACT_ENTRY = "panes:entry";
const ARTIFACT_SOURCE = "panes:source";
const REACT_MODULE = "panes:react";

export function createReactBuildOptions(source: string): BuildOptions {
  return {
    bundle: true,
    entryPoints: [ARTIFACT_ENTRY],
    format: "iife",
    jsx: "transform",
    jsxFactory: "globalThis.__PANES_REACT__.createElement",
    jsxFragment: "globalThis.__PANES_REACT__.Fragment",
    logLevel: "silent",
    platform: "browser",
    plugins: [createArtifactModulePlugin(source)],
    supported: { "inline-script": true },
    target: ["es2022"],
    write: false,
  };
}

function createArtifactModulePlugin(source: string): Plugin {
  return {
    name: "panes-artifact-modules",
    setup(build) {
      build.onStart(() => {
        if (/\b(?:import\s*(?:\(|\.)|require\s*\()/.test(source)) {
          return {
            errors: [
              {
                text: "Dynamic imports, import.meta, and require() are not supported in React artifacts",
              },
            ],
          };
        }
      });

      build.onResolve({ filter: /^panes:entry$/ }, () => ({
        namespace: "panes",
        path: ARTIFACT_ENTRY,
      }));
      build.onResolve({ filter: /^panes:source$/ }, () => ({
        namespace: "panes",
        path: ARTIFACT_SOURCE,
      }));
      build.onResolve({ filter: /^react$/ }, () => ({
        namespace: "panes",
        path: REACT_MODULE,
      }));
      build.onResolve({ filter: /.*/ }, (args) => ({
        errors: [
          {
            text: `Unsupported React artifact import "${args.path}". Supported imports: ${SUPPORTED_REACT_IMPORTS.join(", ")}`,
          },
        ],
      }));

      build.onLoad({ filter: /^panes:entry$/, namespace: "panes" }, () => ({
        contents:
          'import Component from "panes:source"; globalThis.__PANES_COMPONENT__ = Component;',
        loader: "js",
      }));
      build.onLoad({ filter: /^panes:source$/, namespace: "panes" }, () => ({
        contents: source,
        loader: "tsx",
        resolveDir: "/",
      }));
      build.onLoad({ filter: /^panes:react$/, namespace: "panes" }, () => ({
        contents: `
          const React = globalThis.__PANES_REACT__;
          export default React;
          export const { ${PUBLIC_REACT_EXPORTS.join(", ")} } = React;
        `,
        loader: "js",
      }));
    },
  };
}

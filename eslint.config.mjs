import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/**",
      ".next/**",
      ".next-desktop/**",
      "src-tauri/resources/server/**",
      "src-tauri/target/**",
      // demo/ is a separate Next.js project with its own lint config.
      "demo/**",
      // Generated, minified library bundles (scripts/build-preview-runtime.mjs).
      "public/preview-runtime/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // The SDK facade (docs/architecture-improvement-plan.zh-CN.md, stage A) is the
    // one place that adapts to the SDK, so it must stay importable from both
    // bundles: no SDK types, no Node built-ins. `lib/pi-types.ts` is where SDK
    // types are mirrored; a facade module that needs one puts it there.
    files: ["lib/pi/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@earendil-works/*"],
            message: "lib/pi/ must not import the SDK; mirror the type in lib/pi-types.ts or take it as a parameter.",
          },
          {
            group: ["node:*", "fs", "fs/promises", "path", "os", "crypto", "child_process"],
            message: "lib/pi/ must stay runtime-agnostic (it is imported by client code too).",
          },
        ],
      }],
    },
  },
];

export default eslintConfig;

import { fileURLToPath } from "node:url";

const solidStub = `
export function useKeyboard() {}
`;

const jsxRuntimeStub = `
export const Fragment = (props) => props?.children ?? null;
export function jsx(type, props) {
  if (typeof type === "function") return type(props ?? {});
  return { type, props: props ?? {} };
}
export const jsxs = jsx;
export const jsxDEV = jsx;
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opentui/solid") {
    return {
      url: `data:text/javascript,${encodeURIComponent(solidStub)}`,
      shortCircuit: true,
    };
  }
  if (
    specifier === "@opentui/solid/jsx-runtime" ||
    specifier === "@opentui/solid/jsx-dev-runtime"
  ) {
    return {
      url: `data:text/javascript,${encodeURIComponent(jsxRuntimeStub)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".scm") || url.endsWith(".wasm")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(fileURLToPath(url))};`,
    };
  }
  return nextLoad(url, context);
}
